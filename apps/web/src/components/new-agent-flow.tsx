import { type ApiError, unwrap } from "@agent-platform/client";
import type {
  ActivateAgentResponse,
  AgentCard,
  AgentDetail,
  ProfileSummary,
} from "@agent-platform/contracts";
import {
  agentCardStep,
  agentIdentityStep,
  agentReleaseStep,
} from "@agent-platform/core/forms";
import {
  formAlerts,
  type StepForm,
  submitStep,
  useAgentPlatform,
  useStepForm,
  useStepper,
} from "@agent-platform/react";
import {
  Button,
  ConfirmDialog,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Stepper,
} from "@agent-platform/ui";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useBlocker, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import type { z } from "zod";
import { agentQuery, profilesQuery, queryKeys } from "../api/queries.ts";
import { FunnelResetNotice, useFunnel } from "../funnel/tanstack-funnel.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  AgentCardFields,
  type ApiCard,
  CARD_ERROR_FIELDS,
  type CardDraft,
  type CardErrors,
  EMPTY_DRAFT,
} from "./agent-card-form.tsx";
import { StepHeading, useStepMoved } from "./step-heading.tsx";

/**
 * `flow` names one run of the flow; every step's input carries it. `card` is
 * the job step's input as typed, kept so a reload does not lose it.
 */
type Steps = {
  name: { flow: string; name?: string; slug?: string };
  job: { flow: string; name: string; slug: string; card?: unknown };
  release: {
    flow: string;
    name: string;
    slug: string;
    agentId: string;
    versionId: string;
  };
  activate: {
    flow: string;
    name: string;
    slug: string;
    agentId: string;
    versionId: string;
    releaseId: string;
  };
};

const hasText = (data: unknown, keys: readonly string[]) =>
  typeof data === "object" &&
  data !== null &&
  keys.every(
    (key) => typeof (data as Record<string, unknown>)[key] === "string",
  );

const STEP_IDS = ["name", "job", "release", "activate"] as const;
const STEP_LABEL = {
  name: "agents.flow.name",
  job: "agents.flow.job",
  release: "agents.flow.release",
  activate: "agents.flow.activate",
} as const satisfies Record<keyof Steps, MessageKey>;

const NEW_CARD_STEP = agentCardStep();
const CARD_FIELDS = Object.keys(EMPTY_DRAFT) as (keyof CardDraft)[];
const KEEP_INPUT_DELAY_MS = 300;

/** Input kept in history.state from before a deploy may not fit the form. */
const isCardDraft = (value: unknown): value is CardDraft =>
  typeof value === "object" &&
  value !== null &&
  CARD_FIELDS.every(
    (key) =>
      typeof (value as Record<string, unknown>)[key] ===
      typeof EMPTY_DRAFT[key],
  ) &&
  AGENT_CARD_LANGUAGE_VALUES.includes((value as CardDraft).language) &&
  ["all", "list"].includes((value as CardDraft).toolsMode);

/**
 * The slug a name suggests: what is left of it in lowercase kebab-case. A
 * name with no Latin letters or digits suggests nothing.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** JSON with object keys sorted, so two equal cards compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * The version a save resolved to: the server keeps one version per card
 * content, so the card sent may match an older version than the highest.
 * The whole card counts, fields the form has no input for included.
 */
function savedVersionId(detail: AgentDetail, sent: AgentCard): string {
  const version = detail.versions.find(
    (v) => canonical(v.card) === canonical(sent),
  );
  if (!version) throw new Error("the saved card matches no version");
  return version.id;
}

const latestCard = (detail: AgentDetail) =>
  [...detail.versions].sort((a, b) => b.version_no - a.version_no)[0]?.card;

/** What the job step saved, kept per flow so a reload or a return finds it. */
interface SavedDraft {
  readonly agentId: string;
  readonly name: string;
  readonly slug: string;
  readonly card: CardDraft;
}

const draftKey = (flow: string) => `new-agent.${flow}`;

function readDraft(flow: string): SavedDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(flow));
    return raw ? (JSON.parse(raw) as SavedDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(flow: string, draft: SavedDraft) {
  try {
    sessionStorage.setItem(draftKey(flow), JSON.stringify(draft));
  } catch {
    // Without storage the draft is known only while this page stays open.
  }
}

/**
 * Making an agent in four steps. The job step saves the agent as a draft
 * (D9), so leaving after it keeps the agent; going back to the first two
 * steps afterwards edits that draft instead of making another.
 */
export function NewAgentFlow({
  refuse,
}: {
  /** The sentence for a refused request. */
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const [newFlow] = useState(() => crypto.randomUUID());
  const funnel = useFunnel<Steps>({
    id: "new-agent",
    initial: { step: "name", context: { flow: newFlow } },
    steps: {
      name: {
        guard: (data): data is Steps["name"] => hasText(data, ["flow"]),
      },
      job: {
        guard: (data): data is Steps["job"] =>
          hasText(data, ["flow", "name", "slug"]),
      },
      release: {
        guard: (data): data is Steps["release"] =>
          hasText(data, ["flow", "name", "slug", "agentId", "versionId"]),
      },
      activate: {
        guard: (data): data is Steps["activate"] =>
          hasText(data, [
            "flow",
            "name",
            "slug",
            "agentId",
            "versionId",
            "releaseId",
          ]),
      },
    },
  });
  const { flow } = funnel.context;
  const restored = funnel.context as Partial<Steps["job"]>;
  // The draft this flow saved; going back to the first steps edits it.
  const [saved, setSaved] = useState(() => readDraft(flow));
  const identity = useStepForm(agentIdentityStep, {
    defaultValues: {
      name: restored.name ?? saved?.name ?? "",
      slug: restored.slug ?? saved?.slug ?? "",
    },
  });
  // The first entry holds no context until written, so coming back to it
  // would start a new flow, apart from the draft this one saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    if (funnel.index === 0)
      void funnel.history.replace(funnel.step, funnel.context);
  }, []);
  const card = useStepForm(NEW_CARD_STEP, {
    defaultValues: isCardDraft(restored.card)
      ? restored.card
      : (saved?.card ?? EMPTY_DRAFT),
  });
  const cardInput = useWatch({ control: card.control }) as CardDraft;
  const identityInput = useWatch({ control: identity.control });
  const router = useRouter();
  const keepTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the funnel object is new each render
  useEffect(() => {
    if (funnel.step !== "job") return;
    const kept = (funnel.context as Steps["job"]).card;
    if (canonical(kept ?? EMPTY_DRAFT) === canonical(cardInput)) return;
    keepTimer.current = setTimeout(() => {
      // A back or forward lands before this component hears of it; writing
      // then would put the job step over the entry just reached.
      const at = new URLSearchParams(router.history.location.search);
      if (at.get("new-agent.step") === "job")
        void funnel.history.replace("job", { card: cardInput });
    }, KEEP_INPUT_DELAY_MS);
    return () => clearTimeout(keepTimer.current);
  }, [cardInput, funnel.step]);

  // Moving between steps keeps the input; leaving the flow drops what the
  // draft does not hold.
  const kept = saved ?? { name: "", slug: "", card: EMPTY_DRAFT };
  const unsaved = useRef(false);
  unsaved.current =
    identityInput.name !== kept.name ||
    identityInput.slug !== kept.slug ||
    canonical(cardInput) !== canonical(kept.card);
  const leaving = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unsaved.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => unsaved.current,
    withResolver: true,
  });
  const catalog = useQuery(profilesQuery(client));
  const savedPastJob = funnel.step === "release" || funnel.step === "activate";
  const moved = useStepMoved(funnel.step);

  const stepper = useStepper({
    steps: STEP_IDS.map((id) => ({ id, label: t(STEP_LABEL[id]) })),
    currentStepId: funnel.step,
    onStepSelect: (id) => {
      const at = funnel.historySteps
        .map(({ step }): string => step)
        .lastIndexOf(id);
      if (at >= 0) void funnel.history.go(at - funnel.index);
    },
  });
  const steps = stepper.steps.map((step) => ({
    ...step,
    // Past the save, the stepper does not lead back to making another.
    disabled: step.disabled || (savedPastJob && step.id !== funnel.step),
  }));

  const saveDraft = async (
    values: z.output<typeof NEW_CARD_STEP>,
    context: Steps["job"],
  ) => {
    const input = card.getValues();
    // An edit of the draft starts from its latest card, so fields the form
    // has no input for, set elsewhere since, survive it.
    const base = saved
      ? latestCard(
          await queryClient.fetchQuery(agentQuery(client, saved.agentId)),
        )
      : undefined;
    const sent = base ? agentCardStep(base).parse(input) : values;
    const detail = (await unwrap(
      saved
        ? client.PATCH("/v1/agents/{id}", {
            params: { path: { id: saved.agentId } },
            body: {
              ...(context.name !== saved.name ? { name: context.name } : {}),
              card: sent as unknown as ApiCard,
            },
          })
        : client.POST("/v1/agents", {
            body: {
              slug: context.slug,
              name: context.name,
              card: sent as unknown as ApiCard,
            },
          }),
    )) as AgentDetail;
    const draft = {
      agentId: detail.agent.id,
      name: detail.agent.name,
      slug: detail.agent.slug,
      card: input,
    };
    setSaved(draft);
    writeDraft(flow, draft);
    // The fields show what was saved, trimmed as the server keeps it.
    identity.reset({ name: draft.name, slug: draft.slug });
    queryClient.setQueryData(queryKeys.agent(detail.agent.id), detail);
    await queryClient.invalidateQueries({
      queryKey: queryKeys.agents,
      exact: true,
    });
    return {
      agentId: detail.agent.id,
      versionId: savedVersionId(detail, sent),
      // The job context may hold input from before the last edit; the steps
      // after it carry what was saved.
      card: input,
    };
  };

  return (
    <div className="flex flex-col gap-6">
      <FunnelResetNotice funnel={funnel} />
      <Stepper label={t("agents.flow.label")} {...stepper} steps={steps} />
      <funnel.Render
        name={({ history }) => (
          <NameStep
            form={identity}
            locked={saved !== null}
            focus={moved}
            onNext={(values) => history.push("job", values)}
          />
        )}
        job={({ context, history }) => (
          <JobStep
            form={card}
            catalog={catalog}
            focus={moved}
            onSave={async (values) => {
              clearTimeout(keepTimer.current);
              await history.push("release", await saveDraft(values, context));
            }}
            refuse={refuse}
          />
        )}
        release={({ context, history }) => (
          <ReleaseStep
            agentId={context.agentId}
            versionId={context.versionId}
            focus={moved}
            onReleased={(releaseId) => history.push("activate", { releaseId })}
            refuse={refuse}
          />
        )}
        activate={({ context }) => (
          <ActivateStep
            agentId={context.agentId}
            releaseId={context.releaseId}
            focus={moved}
            refuse={refuse}
          />
        )}
      />
      <ConfirmDialog
        open={leaving.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) leaving.reset?.();
        }}
        title={t("agents.flow.leaveTitle")}
        consequence={t("agents.flow.leaveConsequence")}
        confirmLabel={t("agents.flow.leave")}
        cancelLabel={t("agents.flow.stay")}
        tone="danger"
        onConfirm={() => leaving.proceed?.()}
      />
    </div>
  );
}

function Alerts({ lines }: { readonly lines: readonly string[] }) {
  return lines.map((line) => (
    <p key={line} role="alert" className="m-0 text-destructive text-sm">
      {line}
    </p>
  ));
}

function NameStep({
  form,
  locked,
  focus,
  onNext,
}: {
  readonly form: StepForm<typeof agentIdentityStep>;
  readonly locked: boolean;
  readonly focus: boolean;
  readonly onNext: (values: Omit<Steps["job"], "flow">) => void;
}) {
  const { t } = useI18n();
  const { errors } = form.formState;
  const name = form.register("name", {
    onChange: (event: { target: { value: string } }) => {
      // The identifier follows the name until someone types their own.
      if (!locked && !form.getFieldState("slug").isDirty)
        form.setValue("slug", slugFromName(event.target.value));
    },
  });
  return (
    <form
      className="flex max-w-2xl flex-col gap-6"
      noValidate
      onSubmit={form.handleSubmit(onNext)}
    >
      <StepHeading focus={focus}>{t("agents.flow.name")}</StepHeading>
      <Field>
        <FieldLabel>{t("agents.name")}</FieldLabel>
        <Input maxLength={120} {...name} />
        <FieldError>{errors.name?.message}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{t("agents.slug")}</FieldLabel>
        <Input maxLength={64} readOnly={locked} {...form.register("slug")} />
        <FieldDescription>
          {t(locked ? "agents.slugLocked" : "agents.slugHint")}
        </FieldDescription>
        <FieldError>
          {errors.slug?.type === "invalid_format"
            ? t("field.slugFormat")
            : errors.slug?.message}
        </FieldError>
      </Field>
      <Alerts lines={formAlerts(errors, ["name", "slug"])} />
      <div>
        <Button type="submit">{t("agents.flow.next")}</Button>
      </div>
    </form>
  );
}

function JobStep({
  form,
  catalog,
  focus,
  onSave,
  refuse,
}: {
  readonly form: StepForm<typeof NEW_CARD_STEP>;
  readonly catalog: UseQueryResult<{ items: ProfileSummary[] }>;
  readonly focus: boolean;
  readonly onSave: (card: z.output<typeof NEW_CARD_STEP>) => Promise<unknown>;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const draft = useWatch({ control: form.control }) as CardDraft;
  const { errors, isSubmitted, isSubmitting } = form.formState;
  const change = (next: CardDraft) => {
    for (const key of CARD_FIELDS)
      if (next[key] !== draft[key])
        form.setValue(key, next[key], {
          shouldDirty: true,
          shouldValidate: isSubmitted,
        });
  };
  const fieldErrors: CardErrors = Object.fromEntries(
    CARD_ERROR_FIELDS.map((key) => [key, errors[key]?.message]),
  );
  return (
    <form
      className="flex max-w-2xl flex-col gap-6"
      noValidate
      onSubmit={submitStep(form, onSave, refuse)}
    >
      <StepHeading focus={focus}>{t("agents.flow.job")}</StepHeading>
      <p className="m-0 text-muted-foreground text-sm">
        {t("agents.flow.jobIntro")}
      </p>
      <AgentCardFields
        draft={draft}
        catalog={catalog}
        onChange={change}
        errors={fieldErrors}
      />
      <Alerts lines={formAlerts(errors, CARD_ERROR_FIELDS)} />
      <div>
        <Button type="submit" disabled={isSubmitting || !catalog.isSuccess}>
          {isSubmitting ? t("agents.flow.saving") : t("agents.flow.saveDraft")}
        </Button>
      </div>
    </form>
  );
}

function LaterLink({ agentId }: { readonly agentId: string }) {
  const { t } = useI18n();
  return (
    <Button asChild variant="ghost">
      <Link to="/agents/$id" params={{ id: agentId }}>
        {t("agents.flow.later")}
      </Link>
    </Button>
  );
}

function ReleaseStep({
  agentId,
  versionId,
  focus,
  onReleased,
  refuse,
}: {
  readonly agentId: string;
  readonly versionId: string;
  readonly focus: boolean;
  readonly onReleased: (releaseId: string) => void;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const agent = useQuery(agentQuery(client, agentId));
  const profiles = useQuery(profilesQuery(client));
  const cardModel = agent.data?.versions.find((v) => v.id === versionId)?.card
    .model;
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <StepHeading focus={focus}>{t("agents.flow.release")}</StepHeading>
      <p className="m-0 text-muted-foreground text-sm">
        {t("agents.flow.releaseIntro")}
      </p>
      {agent.error ? (
        <Alerts lines={[refuse(agent.error)]} />
      ) : profiles.error ? (
        <Alerts
          lines={[
            t("agent.releases.profilesFailed", {
              reason: t(errorKey((profiles.error as ApiError).code)),
            }),
          ]}
        />
      ) : profiles.data && agent.data ? (
        <ReleaseForm
          agentId={agentId}
          versionId={versionId}
          cardModel={cardModel}
          profiles={profiles.data.items}
          onReleased={onReleased}
          refuse={refuse}
        />
      ) : (
        <p className="m-0 text-muted-foreground text-sm">
          {t("agent.releases.profilesLoading")}
        </p>
      )}
      <div>
        <LaterLink agentId={agentId} />
      </div>
    </section>
  );
}

function ReleaseForm({
  agentId,
  versionId,
  cardModel,
  profiles,
  onReleased,
  refuse,
}: {
  readonly agentId: string;
  readonly versionId: string;
  readonly cardModel: string | undefined;
  readonly profiles: readonly ProfileSummary[];
  readonly onReleased: (releaseId: string) => void;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const form = useStepForm(agentReleaseStep, {
    defaultValues: {
      runtime_profile_id:
        (profiles.find((p) => p.model === cardModel) ?? profiles[0])?.id ?? "",
    },
  });
  const chosen = useWatch({
    control: form.control,
    name: "runtime_profile_id",
  });
  const profileModel = profiles.find((p) => p.id === chosen)?.model;
  const { errors, isSubmitting } = form.formState;
  const release = async ({
    runtime_profile_id,
  }: z.output<typeof agentReleaseStep>) => {
    const result = await unwrap(
      client.POST("/v1/agents/{id}/releases", {
        params: { path: { id: agentId } },
        body: { version_id: versionId, runtime_profile_id },
      }),
    );
    await queryClient.invalidateQueries({ queryKey: queryKeys.agent(agentId) });
    onReleased(result.release.id);
  };
  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={submitStep(form, release, refuse)}
    >
      <Field>
        <FieldLabel>{t("agent.releases.profile")}</FieldLabel>
        <NativeSelect {...form.register("runtime_profile_id")}>
          {profiles.map((profile) => (
            <NativeSelectOption key={profile.id} value={profile.id}>
              {t(
                cardModel === undefined || profile.model === cardModel
                  ? "agent.releases.profileOption"
                  : "agent.releases.profileOptionMismatch",
                { profile: profile.id, model: profile.model },
              )}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>{t("agent.releases.profileHint")}</FieldDescription>
        {cardModel !== undefined &&
        profileModel !== undefined &&
        cardModel !== profileModel ? (
          <FieldDescription className="web-notice">
            {t("agent.releases.modelMismatch", {
              card: cardModel,
              profile: profileModel,
            })}
          </FieldDescription>
        ) : null}
        <FieldError>{errors.runtime_profile_id?.message}</FieldError>
      </Field>
      <Alerts lines={formAlerts(errors, ["runtime_profile_id"])} />
      <div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? t("agent.releases.creating")
            : t("agents.flow.createRelease")}
        </Button>
      </div>
    </form>
  );
}

function ActivateStep({
  agentId,
  releaseId,
  focus,
  refuse,
}: {
  readonly agentId: string;
  readonly releaseId: string;
  readonly focus: boolean;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const agent = useQuery(agentQuery(client, agentId));
  const activate = useMutation<ActivateAgentResponse, unknown, number>({
    mutationFn: (expected) =>
      unwrap(
        client.POST("/v1/agents/{id}/activate", {
          params: { path: { id: agentId } },
          body: { release_id: releaseId, expected_revision: expected },
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agent(agentId) }),
      ]);
    },
  });
  const name = agent.data?.agent.name ?? "";
  // The button pressed is gone after the switch; focus goes to what is next.
  const opened = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (activate.isSuccess) opened.current?.focus();
  }, [activate.isSuccess]);
  return (
    <section className="flex max-w-2xl flex-col gap-6">
      <StepHeading focus={focus}>{t("agents.flow.activate")}</StepHeading>
      {/* Mounted before the result, so the result is read when it lands. */}
      <output className={activate.isSuccess ? "web-notice" : undefined}>
        {activate.isSuccess ? t("agents.flow.done", { name }) : null}
      </output>
      {activate.isSuccess ? (
        <div>
          <Button asChild>
            <Link to="/agents/$id" params={{ id: agentId }} ref={opened}>
              {t("agents.flow.open")}
            </Link>
          </Button>
        </div>
      ) : (
        <>
          <p className="m-0 text-muted-foreground text-sm">
            {t("agents.flow.activateIntro")}
          </p>
          {activate.error ? <Alerts lines={[refuse(activate.error)]} /> : null}
          {agent.error ? <Alerts lines={[refuse(agent.error)]} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={activate.isPending || !agent.data}
              onClick={() =>
                agent.data &&
                activate.mutate(agent.data.agent.activation_revision)
              }
            >
              {activate.isPending
                ? t("agents.flow.activating")
                : t("agents.flow.turnOn")}
            </Button>
            <LaterLink agentId={agentId} />
          </div>
        </>
      )}
    </section>
  );
}

import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Link,
  lazyRouteComponent,
  useBlocker,
  useRouter,
} from "@tanstack/react-router";
import { type ApiClient, type ApiError, unwrap } from "@werft-ai/client";
import type {
  ActivateAgentResponse,
  AgentCard,
  AgentDetail,
  ProfileSummary,
} from "@werft-ai/contracts";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
import {
  agentCardStep,
  agentIdentityStep,
  agentReleaseStep,
} from "@werft-ai/core/forms";
import {
  formAlerts,
  type StepForm,
  submitStep,
  useAgentPlatform,
  useStepForm,
  useStepper,
} from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Stepper,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { useWatch } from "react-hook-form";
import type { z } from "zod";
import {
  agentListsFilter,
  agentQuery,
  profilesQuery,
  queryKeysOf,
  scopedKey,
} from "../api/queries.ts";
import { FunnelResetNotice, useFunnel } from "../funnel/tanstack-funnel.tsx";
import { errorKey, type MessageKey, useI18n } from "../i18n/i18n.tsx";
import {
  AGENT_FORM,
  AgentCardFields,
  type ApiCard,
  CARD_ERROR_FIELDS,
  type CardDraft,
  type CardErrors,
  cardDraftOf,
  EMPTY_DRAFT,
  toolsBlocked,
} from "./agent-card-form.tsx";
import { Notice } from "./auth-page.tsx";
import { LoadFailure } from "./load-failure.tsx";
import { useTeamChoices } from "./managing-team.tsx";
import { ProfileOptions, pickable } from "./profile-options.tsx";
import { StepHeading, useStepMoved } from "./step-heading.tsx";

const SlackConnect = lazyRouteComponent(
  () => import("../routes/agent-detail/slack.tsx"),
  "SlackConnect",
);

/**
 * `flow` names one run of the flow; every step's input carries it. `card` is
 * the job step's input as typed, kept so a reload does not lose it.
 */
type Steps = {
  channels: {
    flow: string;
    name: string;
    slug: string;
    agentId: string;
    versionId: string;
    releaseId: string;
  };
  name: {
    flow: string;
    name?: string;
    slug?: string;
    description?: string;
    managing_team_id?: string;
  };
  job: {
    flow: string;
    name: string;
    slug: string;
    description?: string;
    managing_team_id?: string;
    card?: unknown;
  };
  release: {
    flow: string;
    name: string;
    slug: string;
    agentId: string;
    versionId: string;
    /** The profile the job step previewed tools with. */
    previewId?: string;
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

const STEP_IDS = ["name", "job", "release", "activate", "channels"] as const;
const STEP_LABEL = {
  channels: "agents.flow.channels",
  name: "agents.flow.name",
  job: "agents.flow.job",
  release: "agents.flow.release",
  activate: "agents.flow.activate",
} as const satisfies Record<keyof Steps, MessageKey>;

const NEW_CARD_STEP = agentCardStep();
const CARD_FIELDS = Object.keys(EMPTY_DRAFT) as (keyof CardDraft)[];
const KEEP_INPUT_DELAY_MS = 300;

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
  readonly description: string;
  /** Null on a draft saved before the flow asked for one. */
  readonly managingTeamId: string | null;
  readonly card: CardDraft;
}

/** The start of every flow id of who is signed in, in their workspace. */
const flowOwner = (client: ApiClient) => {
  const [{ actor, workspace }] = scopedKey(client);
  return `${actor}@${workspace}/`;
};

const draftKey = (flow: string) => `new-agent.${flow}`;

function readDraft(flow: string): SavedDraft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(flow));
    if (!raw) return null;
    const draft = JSON.parse(raw) as SavedDraft;
    // The agent was saved, so the draft stays even when its input does not.
    return {
      ...draft,
      description:
        typeof draft.description === "string" ? draft.description : "",
      managingTeamId:
        typeof draft.managingTeamId === "string" ? draft.managingTeamId : null,
      card: cardDraftOf(draft.card) ?? EMPTY_DRAFT,
    };
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
 * Making an agent in five steps. The job step saves the agent as a draft
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
  const owner = flowOwner(client);
  const [newFlow] = useState(() => `${owner}${crypto.randomUUID()}`);
  // Input this tab kept from someone else signed in before fails every
  // guard, so the flow starts over instead of showing it.
  const ours = (data: unknown, keys: readonly string[]) =>
    hasText(data, keys) && (data as { flow: string }).flow.startsWith(owner);
  const funnel = useFunnel<Steps>({
    id: "new-agent",
    initial: { step: "name", context: { flow: newFlow } },
    steps: {
      channels: {
        guard: (data): data is Steps["channels"] =>
          ours(data, [
            "flow",
            "name",
            "slug",
            "agentId",
            "versionId",
            "releaseId",
          ]),
      },
      name: {
        guard: (data): data is Steps["name"] => ours(data, ["flow"]),
      },
      job: {
        guard: (data): data is Steps["job"] =>
          ours(data, ["flow", "name", "slug"]),
      },
      release: {
        guard: (data): data is Steps["release"] =>
          ours(data, ["flow", "name", "slug", "agentId", "versionId"]),
      },
      activate: {
        guard: (data): data is Steps["activate"] =>
          ours(data, [
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
      description:
        (typeof restored.description === "string"
          ? restored.description
          : undefined) ??
        saved?.description ??
        "",
    },
  });
  // Held beside the identity form: the team is chosen, not typed.
  const [team, setTeam] = useState(
    (typeof restored.managing_team_id === "string"
      ? restored.managing_team_id
      : undefined) ??
      saved?.managingTeamId ??
      "",
  );
  // The first entry holds no context until written, so coming back to it
  // would start a new flow, apart from the draft this one saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
  useEffect(() => {
    if (funnel.index === 0)
      void funnel.history.replace(funnel.step, funnel.context);
  }, []);
  const card = useStepForm(NEW_CARD_STEP, {
    defaultValues: cardDraftOf(restored.card) ?? saved?.card ?? EMPTY_DRAFT,
  });
  // The profile the job step previewed tools with, which the release step
  // then starts from; unpicked, both take the first that runs the model.
  const [previewId, setPreviewId] = useState<string>();
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
  const kept = saved ?? {
    name: "",
    slug: "",
    description: "",
    managingTeamId: null,
    card: EMPTY_DRAFT,
  };
  const unsaved = useRef(false);
  unsaved.current =
    identityInput.name !== kept.name ||
    identityInput.slug !== kept.slug ||
    identityInput.description !== kept.description ||
    // A team picked for an unsaved agent; a saved one keeps its own.
    (saved === null && team !== "") ||
    canonical(cardInput) !== canonical(kept.card);
  const leaving = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      unsaved.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => unsaved.current,
    withResolver: true,
  });
  const catalog = useQuery(profilesQuery(client));
  const savedPastJob =
    funnel.step === "release" ||
    funnel.step === "activate" ||
    funnel.step === "channels";
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
    const description =
      typeof context.description === "string" ? context.description : "";
    const detail = (await unwrap(
      saved
        ? client.PATCH("/v1/agents/{id}", {
            params: { path: { id: saved.agentId } },
            body: {
              ...(context.name !== saved.name ? { name: context.name } : {}),
              ...(description !== saved.description ? { description } : {}),
              card: sent as unknown as ApiCard,
            },
          })
        : client.POST("/v1/agents", {
            body: {
              slug: context.slug,
              name: context.name,
              ...(description === "" ? {} : { description }),
              ...(typeof context.managing_team_id === "string" &&
              context.managing_team_id !== ""
                ? { managing_team_id: context.managing_team_id }
                : {}),
              card: sent as unknown as ApiCard,
            },
          }),
    )) as AgentDetail;
    const draft = {
      agentId: detail.agent.id,
      name: detail.agent.name,
      slug: detail.agent.slug,
      description: detail.agent.description ?? "",
      managingTeamId: detail.agent.managing_team_id,
      card: input,
    };
    setSaved(draft);
    setTeam(draft.managingTeamId ?? "");
    writeDraft(flow, draft);
    // The fields show what was saved, trimmed as the server keeps it.
    identity.reset({
      name: draft.name,
      slug: draft.slug,
      description: draft.description,
    });
    queryClient.setQueryData(
      queryKeysOf(client).agent(detail.agent.id),
      detail,
    );
    await queryClient.invalidateQueries(agentListsFilter(client));
    return {
      agentId: detail.agent.id,
      versionId: savedVersionId(detail, sent),
      // The job context may hold input from before the last edit; the steps
      // after it carry what was saved.
      card: input,
    };
  };

  return (
    <div className="flex flex-col gap-[var(--ap-space-block)]">
      <FunnelResetNotice funnel={funnel} />
      <Stepper label={t("agents.flow.label")} {...stepper} steps={steps} />
      <funnel.Render
        name={({ history }) => (
          <NameStep
            form={identity}
            locked={saved !== null}
            focus={moved}
            team={team}
            onTeamChange={setTeam}
            onNext={(values) =>
              history.push("job", { ...values, managing_team_id: team })
            }
          />
        )}
        job={({ context, history }) => (
          <JobStep
            form={card}
            catalog={catalog}
            focus={moved}
            previewId={previewId}
            onPreviewChange={setPreviewId}
            onSave={async (values) => {
              clearTimeout(keepTimer.current);
              await history.push("release", {
                ...(await saveDraft(values, context)),
                ...(previewId === undefined ? {} : { previewId }),
              });
            }}
            refuse={refuse}
          />
        )}
        release={({ context, history }) => (
          <ReleaseStep
            agentId={context.agentId}
            versionId={context.versionId}
            previewId={
              typeof context.previewId === "string"
                ? context.previewId
                : undefined
            }
            focus={moved}
            onReleased={(releaseId) => history.push("activate", { releaseId })}
            refuse={refuse}
          />
        )}
        activate={({ context, history }) => (
          <ActivateStep
            agentId={context.agentId}
            releaseId={context.releaseId}
            focus={moved}
            refuse={refuse}
            onNext={() => void history.push("channels", {})}
          />
        )}
        channels={({ context }) => (
          <section className={AGENT_FORM}>
            <StepHeading focus={moved}>{t("agents.flow.channels")}</StepHeading>
            <Notice>{t("agents.flow.done", { name: context.name })}</Notice>
            <Suspense fallback={<Skeleton label={t("slack.working")} />}>
              <SlackConnect agentId={context.agentId} />
            </Suspense>
            <LaterLink agentId={context.agentId} />
          </section>
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
  return lines.map((line) => <FieldError key={line}>{line}</FieldError>);
}

function NameStep({
  form,
  locked,
  focus,
  team,
  onTeamChange,
  onNext,
}: {
  readonly form: StepForm<typeof agentIdentityStep>;
  readonly locked: boolean;
  readonly focus: boolean;
  /** The managing team's id, "" until one is picked. */
  readonly team: string;
  readonly onTeamChange: (teamId: string) => void;
  readonly onNext: (values: Omit<Steps["job"], "flow">) => void;
}) {
  const { t } = useI18n();
  const { errors } = form.formState;
  const { everywhere, choices, error, refetch } = useTeamChoices();
  const [teamMissing, setTeamMissing] = useState(false);
  const teamSelect = useId();
  // One team leaves nothing to choose.
  const only = choices?.length === 1 ? choices[0]?.id : undefined;
  useEffect(() => {
    if (!locked && team === "" && only !== undefined) onTeamChange(only);
  }, [locked, team, only, onTeamChange]);
  if (error) return <LoadFailure error={error} onRetry={refetch} />;
  if (!locked && choices === undefined)
    return <Skeleton label={t("agents.flow.team")} />;
  // A managing team is required, so without one to pick nothing is made.
  if (!locked && choices?.length === 0)
    return (
      <section className={AGENT_FORM}>
        <StepHeading focus={focus}>{t("agents.flow.name")}</StepHeading>
        <Alert variant="amber">
          <AlertDescription>
            {t(everywhere ? "agents.flow.noTeamAdmin" : "agents.flow.noTeam")}
          </AlertDescription>
          {everywhere ? (
            <AlertActions>
              <Button asChild variant="outline" size="sm">
                <Link to="/members/teams">{t("agents.flow.toTeams")}</Link>
              </Button>
            </AlertActions>
          ) : null}
        </Alert>
      </section>
    );
  const savedTeam = choices?.find((choice) => choice.id === team)?.name;
  const name = form.register("name", {
    onChange: (event: { target: { value: string } }) => {
      // The identifier follows the name until someone types their own.
      if (!locked && !form.getFieldState("slug").isDirty)
        form.setValue("slug", slugFromName(event.target.value));
    },
  });
  return (
    <form
      className={AGENT_FORM}
      noValidate
      onSubmit={form.handleSubmit((values) => {
        if (!locked && team === "") {
          setTeamMissing(true);
          document.getElementById(teamSelect)?.focus();
          return;
        }
        onNext(values);
      })}
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
      <Field>
        <FieldLabel>{t("agents.descriptionOptional")}</FieldLabel>
        <Textarea
          maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
          rows={3}
          {...form.register("description")}
        />
        <FieldDescription>{t("agents.descriptionHint")}</FieldDescription>
        <FieldError>{errors.description?.message}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={teamSelect}>{t("agents.flow.team")}</FieldLabel>
        {locked ? (
          <Text id={teamSelect}>
            {team === "" ? t("managingTeam.unassigned") : (savedTeam ?? team)}
          </Text>
        ) : (
          <NativeSelect
            id={teamSelect}
            required
            aria-invalid={teamMissing && team === ""}
            value={team}
            onChange={(event) => {
              onTeamChange(event.target.value);
              setTeamMissing(false);
            }}
          >
            <NativeSelectOption value="" disabled>
              {t("managingTeam.pickPlaceholder")}
            </NativeSelectOption>
            {choices?.map((choice) => (
              <NativeSelectOption key={choice.id} value={choice.id}>
                {choice.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <FieldDescription>
          {t(locked ? "agents.flow.teamLocked" : "agents.flow.teamHint")}
        </FieldDescription>
        <FieldError>
          {teamMissing && team === "" ? t("agents.flow.teamRequired") : null}
        </FieldError>
      </Field>
      <Alerts lines={formAlerts(errors, ["name", "slug", "description"])} />
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
  previewId,
  onPreviewChange,
  onSave,
  refuse,
}: {
  readonly form: StepForm<typeof NEW_CARD_STEP>;
  readonly catalog: UseQueryResult<{ items: ProfileSummary[] }>;
  readonly focus: boolean;
  readonly previewId: string | undefined;
  readonly onPreviewChange: (profileId: string) => void;
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
      className={AGENT_FORM}
      noValidate
      onSubmit={submitStep(form, onSave, refuse)}
    >
      <StepHeading focus={focus}>{t("agents.flow.job")}</StepHeading>
      <Text variant="sub">{t("agents.flow.jobIntro")}</Text>
      <AgentCardFields
        draft={draft}
        catalog={catalog}
        onChange={change}
        errors={fieldErrors}
        previewable={releasable}
        previewId={previewId}
        onPreviewChange={onPreviewChange}
      />
      <Alerts lines={formAlerts(errors, CARD_ERROR_FIELDS)} />
      <div>
        <Button
          type="submit"
          disabled={
            isSubmitting ||
            !catalog.isSuccess ||
            toolsBlocked(catalog.data.items, draft)
          }
        >
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
  previewId,
  focus,
  onReleased,
  refuse,
}: {
  readonly agentId: string;
  readonly versionId: string;
  readonly previewId: string | undefined;
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
    <section className={AGENT_FORM}>
      <StepHeading focus={focus}>{t("agents.flow.release")}</StepHeading>
      <Text variant="sub">{t("agents.flow.releaseIntro")}</Text>
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
          previewId={previewId}
          profiles={profiles.data.items}
          onReleased={onReleased}
          refuse={refuse}
        />
      ) : (
        <Text variant="sub">{t("agent.releases.profilesLoading")}</Text>
      )}
      <div>
        <LaterLink agentId={agentId} />
      </div>
    </section>
  );
}

// The flow releases without a repository (agent-wizard-rework.md item 1); a
// profile that needs one is released from the agent's releases tab.
const needsRepository = (profile: ProfileSummary) =>
  profile.repository_mode === "required";
const releasable = (profile: ProfileSummary) =>
  pickable(profile) && !needsRepository(profile);

function ReleaseForm({
  agentId,
  versionId,
  cardModel,
  previewId,
  profiles,
  onReleased,
  refuse,
}: {
  readonly agentId: string;
  readonly versionId: string;
  readonly cardModel: string | undefined;
  readonly previewId: string | undefined;
  readonly profiles: readonly ProfileSummary[];
  readonly onReleased: (releaseId: string) => void;
  readonly refuse: (error: unknown) => string;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const runsCard = (profile: ProfileSummary) =>
    cardModel === undefined || profile.models.includes(cardModel);
  // The job step's preview, else the same default it showed.
  const first =
    profiles.find(
      (p) =>
        p.id === previewId &&
        releasable(p) &&
        cardModel !== undefined &&
        runsCard(p),
    ) ??
    profiles.find(
      (p) => releasable(p) && cardModel !== undefined && runsCard(p),
    ) ??
    profiles.find(releasable);
  const fallback = first?.id ?? "";
  const form = useStepForm(agentReleaseStep, {
    defaultValues: { runtime_profile_id: fallback, repository_id: "" },
  });
  const chosen = useWatch({
    control: form.control,
    name: "runtime_profile_id",
  });
  const picked = profiles.find((p) => p.id === chosen);
  const profileModel = picked?.model;
  const { setValue } = form;
  // A refetch can retire the picked version under the open form.
  useEffect(() => {
    if (picked !== undefined && !releasable(picked) && chosen !== fallback)
      setValue("runtime_profile_id", fallback);
  }, [picked, chosen, fallback, setValue]);
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
    await queryClient.invalidateQueries({
      queryKey: queryKeysOf(client).agent(agentId),
    });
    onReleased(result.release.id);
  };
  const someNeedRepository = profiles.some(
    (p) => pickable(p) && needsRepository(p),
  );
  if (first === undefined) {
    return (
      <Alert variant="amber">
        <AlertTitle>
          {t(
            someNeedRepository
              ? "agents.flow.noProfileWithoutRepository"
              : "agents.flow.noProfile",
          )}
        </AlertTitle>
        <AlertDescription>
          {t(
            someNeedRepository
              ? "agents.flow.repositoryLater"
              : "agents.flow.noProfileHint",
          )}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={submitStep(form, release, refuse)}
    >
      <Field>
        <FieldLabel>{t("agent.releases.profile")}</FieldLabel>
        <NativeSelect {...form.register("runtime_profile_id")}>
          <ProfileOptions
            profiles={profiles}
            usable={releasable}
            label={(profile) => {
              const label = t(
                runsCard(profile)
                  ? "agent.releases.profileOption"
                  : "agent.releases.profileOptionMismatch",
                { profile: profile.id, model: profile.model },
              );
              return needsRepository(profile)
                ? `${label} · ${t("agents.flow.repositoryRequired")}`
                : label;
            }}
          />
        </NativeSelect>
        <FieldDescription>{t("agent.releases.profileHint")}</FieldDescription>
        {someNeedRepository ? (
          <FieldDescription>
            {t("agents.flow.repositoryLater")}
          </FieldDescription>
        ) : null}
        <FieldDescription>
          {t("agent.releases.profileUnlisted")}
        </FieldDescription>
        {cardModel !== undefined &&
        profileModel !== undefined &&
        picked !== undefined &&
        !runsCard(picked) ? (
          <Alert variant="amber">
            <FieldDescription>
              {t("agent.releases.modelMismatch", {
                card: cardModel,
                profile: profileModel,
              })}
            </FieldDescription>
          </Alert>
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
  onNext,
}: {
  readonly agentId: string;
  readonly releaseId: string;
  readonly focus: boolean;
  readonly refuse: (error: unknown) => string;
  readonly onNext: () => void;
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
        queryClient.invalidateQueries({ queryKey: queryKeysOf(client).agents }),
        queryClient.invalidateQueries({
          queryKey: queryKeysOf(client).agent(agentId),
        }),
      ]);
      onNext();
    },
  });
  return (
    <section className={AGENT_FORM}>
      <StepHeading focus={focus}>{t("agents.flow.activate")}</StepHeading>
      <Text variant="sub">{t("agents.flow.activateIntro")}</Text>
      {activate.error ? <Alerts lines={[refuse(activate.error)]} /> : null}
      {agent.error ? <Alerts lines={[refuse(agent.error)]} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={activate.isPending || !agent.data}
          onClick={() =>
            agent.data && activate.mutate(agent.data.agent.activation_revision)
          }
        >
          {activate.isPending
            ? t("agents.flow.activating")
            : t("agents.flow.turnOn")}
        </Button>
        <LaterLink agentId={agentId} />
      </div>
    </section>
  );
}

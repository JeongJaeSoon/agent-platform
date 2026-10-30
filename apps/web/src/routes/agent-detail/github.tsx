import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link as RouterLink } from "@tanstack/react-router";
import {
  type ApiClient,
  type ApiError,
  type components,
  unwrap,
} from "@werft-ai/client";
import type { AgentDetail } from "@werft-ai/contracts";
import { queryKeysOf } from "@werft-ai/core";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  Field,
  FieldError,
  FieldLabel,
  Input,
  Link,
  RelativeTime,
  RowList,
  RowListItem,
  SettingRow,
  SideNav,
  SideNavGroup,
  SideNavLayout,
  SideNavLink,
  Skeleton,
  Switch,
} from "@werft-ai/ui";
import { Plus } from "lucide-react";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import {
  errorKey,
  type MessageKey,
  type Translate,
  useI18n,
} from "../../i18n/i18n.tsx";
import { type Notify, useToast } from "./toast.tsx";
import { useCurrentSection } from "./use-current-section.ts";
import { usePageFits } from "./use-page-fits.ts";

type GitHubTabData = components["schemas"]["AgentGitHubResponse"];
type Settings = NonNullable<GitHubTabData["github"]>;
type Feature = keyof Settings["features"];
type AllowEntry = Settings["actions_allow"][number];
type Receipt = components["schemas"]["Receipt"];

const SECTION = {
  use: "github-use",
  repositories: "github-repositories",
  permissions: "github-permissions",
  allowlist: "github-allowlist",
  push: "github-push",
  activity: "github-activity",
} as const;
type SectionKey = keyof typeof SECTION;
const SECTION_BOX =
  "flex scroll-mt-4 flex-col gap-[var(--ap-space-block)] outline-none";
const HEADING = "m-0 font-semibold text-body leading-5";
// The order the mockup lists them in: what most agents turn on first.
const FEATURES: readonly Feature[] = [
  "review",
  "actions",
  "checks",
  "issues",
  "workflows",
];
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.ya?ml$/;
const ALLOW_MAX = 32;
const REF_MAX = 255;

const githubKey = (client: ApiClient, agentId: string) =>
  [...queryKeysOf(client).agent(agentId), "github"] as const;

/** Whether a ref pattern can name an `agent/` branch, which never runs. */
export function refusesAgentRef(ref: string): boolean {
  const slash = ref.indexOf("/");
  if (slash < 0) return false;
  const head = ref
    .slice(0, slash)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*");
  return new RegExp(`^${head}$`).test("agent");
}

const sameEntry = (a: AllowEntry, b: AllowEntry) =>
  a.workflow === b.workflow && (a.ref ?? null) === (b.ref ?? null);

/** How many things the draft changes from what the active release pins. */
export function pendingCount(base: Settings, draft: Settings): number {
  const repos = new Set(base.repositories);
  const drafted = new Set(draft.repositories);
  return (
    [...drafted].filter((id) => !repos.has(id)).length +
    [...repos].filter((id) => !drafted.has(id)).length +
    Number(base.push_approval !== draft.push_approval) +
    FEATURES.filter((f) => base.features[f] !== draft.features[f]).length +
    draft.actions_allow.filter(
      (entry) => !base.actions_allow.some((held) => sameEntry(held, entry)),
    ).length +
    base.actions_allow.filter(
      (entry) => !draft.actions_allow.some((held) => sameEntry(held, entry)),
    ).length
  );
}

function failure(error: unknown, t: Translate): string {
  const code = (error as { code?: string } | null)?.code ?? "INTERNAL_ERROR";
  return t(errorKey(code));
}

function receiptTitle(receipt: Receipt, t: Translate): string {
  const result = (receipt.result ?? {}) as { enabled?: boolean };
  if (receipt.operation === "set_agent_github") {
    return t(
      result.enabled
        ? "agentGitHub.activity.set_agent_github.on"
        : "agentGitHub.activity.set_agent_github.off",
    );
  }
  const key = `agentGitHub.activity.${receipt.operation}${
    receipt.status === "failed" ? ".failed" : ""
  }`;
  return t(key as MessageKey);
}

function ReceiptRow({
  receipt,
  detail,
}: {
  readonly receipt: Receipt;
  readonly detail: AgentDetail;
}) {
  const { t, locale } = useI18n();
  const result = (receipt.result ?? {}) as {
    session_id?: string;
    release_id?: string;
    repository_id?: string;
    purpose?: string;
    workflow?: string;
    ref?: string;
    reason_code?: string;
  };
  const release = detail.releases.find((r) => r.id === result.release_id);
  const parts = [
    result.workflow
      ? result.ref
        ? `${result.workflow} @ ${result.ref}`
        : result.workflow
      : null,
    result.repository_id ?? null,
    result.purpose && receipt.operation === "mint_github_token"
      ? t(`agentGitHub.purpose.${result.purpose}` as MessageKey)
      : null,
    result.reason_code
      ? t(`agentGitHub.refusal.${result.reason_code}` as MessageKey)
      : null,
    release
      ? t("agentGitHub.activity.release", { release: release.label })
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <SettingRow
      title={receiptTitle(receipt, t)}
      badge={
        receipt.status === "failed" ? (
          <Badge variant="red">{t("agentGitHub.refused")}</Badge>
        ) : undefined
      }
      description={parts.join(" · ") || undefined}
      meta={
        result.session_id ? (
          <Link asChild>
            <RouterLink to="/sessions/$id" params={{ id: result.session_id }}>
              {t("agentGitHub.activity.session")}{" "}
              <span className="font-mono">{result.session_id.slice(0, 8)}</span>
            </RouterLink>
          </Link>
        ) : undefined
      }
      status={
        <RelativeTime
          value={receipt.created_at}
          locale={locale}
          className="text-caption text-muted-foreground"
        />
      }
    />
  );
}

function Activity({
  agentId,
  detail,
}: {
  readonly agentId: string;
  readonly detail: AgentDetail;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const activity = useQuery({
    queryKey: [...githubKey(client, agentId), "activity"],
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github/activity", {
          params: { path: { id: agentId } },
        }),
      ),
  });
  return (
    <section
      id={SECTION.activity}
      tabIndex={-1}
      className={SECTION_BOX}
      aria-labelledby={`${SECTION.activity}-title`}
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${SECTION.activity}-title`} className={HEADING}>
          {t("agentGitHub.section.activity")}
        </h2>
        <span className="text-control text-muted-foreground">
          {t("agentGitHub.activityHint")}
        </span>
      </div>
      {activity.error ? (
        <FieldError>{failure(activity.error, t)}</FieldError>
      ) : activity.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : activity.data.items.length === 0 ? (
        <span className="text-control text-muted-foreground">
          {t("agentGitHub.activityEmpty")}
        </span>
      ) : (
        <RowList
          variant="joined"
          aria-label={t("agentGitHub.section.activity")}
        >
          {activity.data.items.map((receipt) => (
            <ReceiptRow key={receipt.id} receipt={receipt} detail={detail} />
          ))}
        </RowList>
      )}
    </section>
  );
}

function EnabledRow({
  agentId,
  enabled,
  notify,
}: {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly notify: Notify;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const update = useMutation({
    mutationFn: (next: boolean) =>
      unwrap(
        client.PUT("/v1/agents/{id}/github/enabled", {
          params: { path: { id: agentId } },
          body: { enabled: next },
        }),
      ),
    onSuccess: async (saved) => {
      setConfirming(false);
      notify(
        t(saved.enabled ? "agentGitHub.enabledOn" : "agentGitHub.enabledOff"),
      );
      await cache.invalidateQueries({ queryKey: githubKey(client, agentId) });
    },
  });
  return (
    <>
      <RowList variant="joined">
        <SettingRow
          title={t("agentGitHub.enabled")}
          badge={<Badge variant="gray">{t("agentGitHub.badge.now")}</Badge>}
          description={t("agentGitHub.enabledHint")}
          meta={
            update.error && !confirming ? (
              <FieldError>{failure(update.error, t)}</FieldError>
            ) : undefined
          }
          status={
            <span className="text-control text-muted-foreground">
              {t(enabled ? "agentGitHub.on" : "agentGitHub.off")}
            </span>
          }
          control={
            <Switch
              aria-label={t("agentGitHub.enabled")}
              checked={enabled}
              aria-disabled={update.isPending}
              onCheckedChange={(checked) => {
                if (update.isPending) return;
                if (checked) update.mutate(true);
                else setConfirming(true);
              }}
            />
          }
        />
      </RowList>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("agentGitHub.disableTitle")}
        consequence={t("agentGitHub.disableBody")}
        confirmLabel={t("agentGitHub.disableConfirm")}
        cancelLabel={t("common.cancel")}
        tone="danger"
        busy={update.isPending}
        onConfirm={() => update.mutate(false)}
      >
        {update.error ? (
          <FieldError>{failure(update.error, t)}</FieldError>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

function SectionHead({
  id,
  title,
  hint,
}: {
  readonly id: string;
  readonly title: MessageKey;
  readonly hint?: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className={HEADING}>
          {t(title)}
        </h2>
        <Badge variant="blue">{t("agentGitHub.badge.release")}</Badge>
      </div>
      {hint ? (
        <span className="text-control text-muted-foreground">{t(hint)}</span>
      ) : null}
    </div>
  );
}

function AllowAdd({
  entries,
  disabled,
  onAdd,
}: {
  readonly entries: readonly AllowEntry[];
  readonly disabled: boolean;
  readonly onAdd: (entry: AllowEntry) => void;
}) {
  const { t } = useI18n();
  const [workflow, setWorkflow] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<MessageKey | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const entry: AllowEntry = {
      workflow: workflow.trim(),
      ...(ref.trim() === "" ? {} : { ref: ref.trim() }),
    };
    const refused: MessageKey | null = !WORKFLOW_FILE.test(entry.workflow)
      ? "agentGitHub.workflowInvalid"
      : entry.ref !== undefined && entry.ref.length > REF_MAX
        ? "agentGitHub.refInvalid"
        : entry.ref !== undefined && refusesAgentRef(entry.ref)
          ? "agentGitHub.refAgent"
          : entries.some((held) => sameEntry(held, entry))
            ? "agentGitHub.duplicate"
            : entries.length >= ALLOW_MAX
              ? "agentGitHub.full"
              : null;
    setError(refused);
    if (refused) return;
    onAdd(entry);
    setWorkflow("");
    setRef("");
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border p-4"
      noValidate
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field>
          <FieldLabel>{t("agentGitHub.workflow")}</FieldLabel>
          <Input
            value={workflow}
            placeholder="release.yml"
            className="font-mono"
            disabled={disabled}
            onChange={(event) => setWorkflow(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel>{t("agentGitHub.ref")}</FieldLabel>
          <Input
            value={ref}
            placeholder="release/*"
            className="font-mono"
            disabled={disabled}
            onChange={(event) => setRef(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline" disabled={disabled}>
          <Plus aria-hidden="true" strokeWidth={1.5} />
          {t("agentGitHub.add")}
        </Button>
      </div>
      <span className="text-caption text-muted-foreground">
        {t("agentGitHub.refHint")}
      </span>
      {error ? <FieldError>{t(error)}</FieldError> : null}
    </form>
  );
}

function GitHubSettings({
  agentId,
  detail,
  data,
  notify,
  sectionKeys,
}: {
  readonly agentId: string;
  readonly detail: AgentDetail;
  readonly data: GitHubTabData;
  readonly notify: Notify;
  readonly sectionKeys: (keys: readonly SectionKey[]) => void;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const cache = useQueryClient();
  const base = data.github ?? data.legacy_defaults;
  const [draft, setDraft] = useState<Settings | null>(null);
  const settings = draft ?? base;
  const release = detail.active_release;
  const saveError = useRef<HTMLDivElement>(null);

  const save = useMutation<
    { label: string; created: boolean },
    ApiError | { readonly notActivated: string; readonly error: ApiError }
  >({
    mutationFn: async () => {
      if (!release || !settings) throw new Error("unsavable");
      const made = await unwrap(
        client.POST("/v1/agents/{id}/releases", {
          params: { path: { id: agentId } },
          body: {
            version_id: release.version_id,
            runtime_profile_id: release.runtime_profile_id,
            ...(release.repository_id === null
              ? {}
              : { repository_id: release.repository_id }),
            github: settings,
          },
        }),
      );
      try {
        await unwrap(
          client.POST("/v1/agents/{id}/activate", {
            params: { path: { id: agentId } },
            body: {
              release_id: made.release.id,
              expected_revision: detail.agent.activation_revision,
            },
          }),
        );
      } catch (error) {
        throw { notActivated: made.release.label, error: error as ApiError };
      }
      return { label: made.release.label, created: made.created };
    },
    onSuccess: async (saved) => {
      setDraft(null);
      notify(
        t(saved.created ? "agentGitHub.saved" : "agentGitHub.savedExisting", {
          release: saved.label,
        }),
      );
      await cache.invalidateQueries({ queryKey: queryKeysOf(client).agents });
    },
    onError: async () => {
      saveError.current?.focus();
      await cache.invalidateQueries({ queryKey: queryKeysOf(client).agents });
    },
  });
  const saveFailure = (() => {
    const error = save.error;
    if (!error) return null;
    if ("notActivated" in error) {
      return error.error.code === "REVISION_CONFLICT"
        ? t("agentGitHub.conflict")
        : t("agentGitHub.savedNotActivated", {
            release: error.notActivated,
            reason: failure(error.error, t),
          });
    }
    return t("agentGitHub.saveRefused", { reason: failure(error, t) });
  })();

  const readOnly =
    !data.enabled || data.unsavable !== null || base === null || save.isPending;
  const edit = (change: (current: Settings) => Settings) => {
    if (readOnly || !settings) return;
    setDraft(change(settings));
  };
  const pending = base && draft ? pendingCount(base, draft) : 0;
  const actionsOn = settings?.features.actions ?? false;
  const keys: SectionKey[] = [
    "use",
    ...(settings
      ? ([
          "repositories",
          "permissions",
          ...(actionsOn ? (["allowlist"] as const) : []),
          "push",
        ] as const)
      : []),
    "activity",
  ];
  // Joined, so a new array with the same sections does not report again.
  const joined = keys.join();
  useLayoutEffect(
    () => sectionKeys(joined.split(",") as SectionKey[]),
    [sectionKeys, joined],
  );
  const version = detail.versions.find(
    (v) => v.id === release?.version_id,
  )?.version_no;

  return (
    <>
      <section
        className="flex flex-col gap-[var(--ap-space-block)]"
        aria-label={t("agentGitHub.status")}
      >
        <RowList variant="joined">
          <RowListItem className="flex flex-wrap items-center gap-x-4 gap-y-2 text-control">
            <Badge variant={data.enabled ? "green" : "gray"}>
              {t(
                data.enabled ? "agentGitHub.state.on" : "agentGitHub.state.off",
              )}
            </Badge>
            <span>
              {base === null || data.github === null
                ? t("agentGitHub.status.repositoriesLegacy")
                : t("agentGitHub.status.repositories", {
                    count: data.github.repositories.length,
                  })}
            </span>
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {t("agentGitHub.status.pushApproval")}
              </span>
              <span>
                {base
                  ? t(base.push_approval ? "agentGitHub.on" : "agentGitHub.off")
                  : "—"}
              </span>
            </span>
            {release ? (
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {t("agentGitHub.status.release")}
                </span>
                <span className="font-mono text-caption">{release.label}</span>
              </span>
            ) : null}
          </RowListItem>
        </RowList>
      </section>
      {pending > 0 || saveFailure ? (
        <Alert
          variant={saveFailure ? "red" : "blue"}
          role="region"
          aria-label={t("agentGitHub.pending.title", { count: pending })}
        >
          <AlertTitle>
            {t("agentGitHub.pending.title", { count: pending })}
          </AlertTitle>
          <AlertDescription>
            {t("agentGitHub.pending.body", {
              version: version ?? "—",
              profile: release?.runtime_profile_id ?? "—",
            })}
            {saveFailure ? (
              <div ref={saveError} tabIndex={-1} className="mt-2 outline-none">
                <FieldError>{saveFailure}</FieldError>
              </div>
            ) : null}
          </AlertDescription>
          <AlertActions>
            <Button
              type="button"
              size="sm"
              disabled={pending === 0 || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("agentGitHub.pending.saving")
                : t("agentGitHub.pending.save")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                setDraft(null);
                save.reset();
              }}
            >
              {t("agentGitHub.pending.revert")}
            </Button>
          </AlertActions>
        </Alert>
      ) : null}
      {data.unsavable ? (
        <Alert variant="amber">
          <AlertTitle>{t("agentGitHub.unsavable.title")}</AlertTitle>
          <AlertDescription>
            {t(`agentGitHub.unsavable.${data.unsavable}`)}
          </AlertDescription>
        </Alert>
      ) : data.github === null && base ? (
        <Alert>
          <AlertDescription>{t("agentGitHub.legacy")}</AlertDescription>
        </Alert>
      ) : null}

      <section
        id={SECTION.use}
        tabIndex={-1}
        className={SECTION_BOX}
        aria-labelledby={`${SECTION.use}-title`}
      >
        <h2 id={`${SECTION.use}-title`} className={HEADING}>
          {t("agentGitHub.section.use")}
        </h2>
        <EnabledRow agentId={agentId} enabled={data.enabled} notify={notify} />
        {data.enabled ? null : (
          <span className="text-control text-muted-foreground">
            {t("agentGitHub.offNote")}
          </span>
        )}
      </section>

      {settings ? (
        <div
          className={`flex flex-col gap-8 ${data.enabled ? "" : "opacity-60"}`}
        >
          <section
            id={SECTION.repositories}
            tabIndex={-1}
            className={SECTION_BOX}
            aria-labelledby={`${SECTION.repositories}-title`}
          >
            <SectionHead
              id={SECTION.repositories}
              title="agentGitHub.section.repositories"
              hint="agentGitHub.repositoriesHint"
            />
            {data.options.repositories.length === 0 ? (
              <span className="text-control text-muted-foreground">
                {t("agentGitHub.repositoriesNone")}
              </span>
            ) : (
              <RowList variant="joined">
                {data.options.repositories.map((repository) => {
                  const on = settings.repositories.includes(repository.id);
                  const locked = repository.id === data.release_repository_id;
                  const blocked = !repository.available && !on;
                  return (
                    <SettingRow
                      key={repository.id}
                      title={repository.id}
                      description={
                        <span className="[overflow-wrap:anywhere]">
                          {repository.url}
                        </span>
                      }
                      meta={
                        locked
                          ? t("agentGitHub.repositoryRelease")
                          : repository.reason
                            ? t(
                                `agentGitHub.repositoryReason.${repository.reason}`,
                              )
                            : undefined
                      }
                      status={
                        <span className="text-control text-muted-foreground">
                          {t(
                            on
                              ? "agentGitHub.repositoryUse"
                              : "agentGitHub.repositoryUnused",
                          )}
                        </span>
                      }
                      control={
                        <Switch
                          aria-label={repository.id}
                          checked={on}
                          disabled={readOnly || locked || blocked}
                          onCheckedChange={(checked) =>
                            edit((current) => ({
                              ...current,
                              repositories: checked
                                ? [...current.repositories, repository.id]
                                : current.repositories.filter(
                                    (id) => id !== repository.id,
                                  ),
                            }))
                          }
                        />
                      }
                    />
                  );
                })}
              </RowList>
            )}
            <span className="text-caption text-muted-foreground">
              {t("agentGitHub.repositoriesFoot")}
            </span>
          </section>

          <section
            id={SECTION.permissions}
            tabIndex={-1}
            className={SECTION_BOX}
            aria-labelledby={`${SECTION.permissions}-title`}
          >
            <SectionHead
              id={SECTION.permissions}
              title="agentGitHub.section.permissions"
              hint="agentGitHub.permissionsHint"
            />
            <RowList variant="joined">
              <SettingRow
                title={t("agentGitHub.base")}
                badge={
                  <Badge variant="gray">{t("agentGitHub.badge.default")}</Badge>
                }
                description={t("agentGitHub.baseHint")}
                status={
                  <span className="text-control text-muted-foreground">
                    {t("agentGitHub.baseState")}
                  </span>
                }
              />
              {FEATURES.map((feature) => {
                const option = data.options.features[feature];
                const on = settings.features[feature];
                return (
                  <SettingRow
                    key={feature}
                    title={t(`agentGitHub.feature.${feature}`)}
                    description={t(`agentGitHub.feature.${feature}Hint`)}
                    meta={
                      option.reason ? (
                        <span>
                          {t(`agentGitHub.featureReason.${option.reason}`)}{" "}
                          {option.reason ===
                          "github_host_unsupported" ? null : (
                            <Link asChild>
                              <RouterLink to="/settings/workspace/github">
                                {t("agentGitHub.settingsLink")}
                              </RouterLink>
                            </Link>
                          )}
                        </span>
                      ) : undefined
                    }
                    status={
                      <span className="text-control text-muted-foreground">
                        {t(on ? "agentGitHub.on" : "agentGitHub.off")}
                      </span>
                    }
                    control={
                      <Switch
                        aria-label={t(`agentGitHub.feature.${feature}`)}
                        checked={on}
                        disabled={readOnly || (!option.available && !on)}
                        onCheckedChange={(checked) =>
                          edit((current) => ({
                            ...current,
                            features: {
                              ...current.features,
                              [feature]: checked,
                            },
                          }))
                        }
                      />
                    }
                  />
                );
              })}
            </RowList>
            {settings.features.workflows && settings.features.actions ? (
              <Alert variant="amber">
                <AlertDescription>
                  {t("agentGitHub.workflowsActions")}
                </AlertDescription>
              </Alert>
            ) : null}
            <span className="text-caption text-muted-foreground">
              {t("agentGitHub.ceilingNote")}{" "}
              <Link asChild>
                <RouterLink to="/settings/workspace/github">
                  {t("agentGitHub.settingsLink")}
                </RouterLink>
              </Link>
            </span>
          </section>

          {actionsOn ? (
            <section
              id={SECTION.allowlist}
              tabIndex={-1}
              className={SECTION_BOX}
              aria-labelledby={`${SECTION.allowlist}-title`}
            >
              <SectionHead
                id={SECTION.allowlist}
                title="agentGitHub.section.allowlist"
                hint="agentGitHub.allowlistHint"
              />
              {settings.actions_allow.length === 0 ? (
                <span className="text-control text-muted-foreground">
                  {t("agentGitHub.allowlistEmpty")}
                </span>
              ) : (
                <RowList
                  variant="joined"
                  aria-label={t("agentGitHub.section.allowlist")}
                >
                  {settings.actions_allow.map((entry) => (
                    <SettingRow
                      key={`${entry.workflow}@${entry.ref ?? ""}`}
                      title={
                        <span className="font-mono">{entry.workflow}</span>
                      }
                      badge={
                        base?.actions_allow.some((held) =>
                          sameEntry(held, entry),
                        ) ? undefined : (
                          <Badge variant="blue">
                            {t("agentGitHub.badge.unsaved")}
                          </Badge>
                        )
                      }
                      description={
                        entry.ref === undefined
                          ? t("agentGitHub.refDefault")
                          : t("agentGitHub.refPattern", { ref: entry.ref })
                      }
                      actions={
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={readOnly}
                          aria-label={t("agentGitHub.removeLabel", {
                            workflow: entry.workflow,
                          })}
                          onClick={() =>
                            edit((current) => ({
                              ...current,
                              actions_allow: current.actions_allow.filter(
                                (held) => !sameEntry(held, entry),
                              ),
                            }))
                          }
                        >
                          {t("agentGitHub.remove")}
                        </Button>
                      }
                    />
                  ))}
                </RowList>
              )}
              <AllowAdd
                entries={settings.actions_allow}
                disabled={readOnly}
                onAdd={(entry) =>
                  edit((current) => ({
                    ...current,
                    actions_allow: [...current.actions_allow, entry],
                  }))
                }
              />
              <Alert>
                <AlertDescription>
                  {t("agentGitHub.allowlistNote")}
                </AlertDescription>
              </Alert>
            </section>
          ) : null}

          <section
            id={SECTION.push}
            tabIndex={-1}
            className={SECTION_BOX}
            aria-labelledby={`${SECTION.push}-title`}
          >
            <SectionHead id={SECTION.push} title="agentGitHub.section.push" />
            <RowList variant="joined">
              <SettingRow
                title={t("agentGitHub.pushApproval")}
                description={t("agentGitHub.pushApprovalHint")}
                status={
                  <span className="text-control text-muted-foreground">
                    {t(
                      settings.push_approval
                        ? "agentGitHub.on"
                        : "agentGitHub.off",
                    )}
                  </span>
                }
                control={
                  <Switch
                    aria-label={t("agentGitHub.pushApproval")}
                    checked={settings.push_approval}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      edit((current) => ({
                        ...current,
                        push_approval: checked,
                      }))
                    }
                  />
                }
              />
            </RowList>
            {settings.push_approval ? null : (
              <Alert variant="amber">
                <AlertDescription>
                  {t("agentGitHub.pushApprovalOff")}
                </AlertDescription>
              </Alert>
            )}
          </section>
        </div>
      ) : null}
      <Activity agentId={agentId} detail={detail} />
    </>
  );
}

const SECTION_LABEL = {
  use: "agentGitHub.section.use",
  repositories: "agentGitHub.section.repositories",
  permissions: "agentGitHub.section.permissions",
  allowlist: "agentGitHub.section.allowlist",
  push: "agentGitHub.section.push",
  activity: "agentGitHub.section.activity",
} as const satisfies Record<SectionKey, MessageKey>;

export default function GitHubTab({
  detail,
}: {
  readonly detail: AgentDetail;
}) {
  const { t } = useI18n();
  const { client } = useAgentPlatform();
  const { notify, toast } = useToast();
  const agentId = detail.agent.id;
  const github = useQuery({
    queryKey: githubKey(client, agentId),
    queryFn: () =>
      unwrap(
        client.GET("/v1/agents/{id}/github", {
          params: { path: { id: agentId } },
        }),
      ),
  });
  const [keys, setKeys] = useState<readonly SectionKey[]>(["use", "activity"]);
  const [current, setCurrent] = useCurrentSection(keys.map((k) => SECTION[k]));
  const jumped = useRef<string>(undefined);
  const [fits, watchPage] = usePageFits();
  const sectionKeys = useRef((next: readonly SectionKey[]) =>
    setKeys((held) => (held.join() === next.join() ? held : next)),
  ).current;

  if (github.isPending) {
    return (
      <div className="flex min-h-96 flex-col gap-6" aria-busy="true">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (github.error) {
    return <FieldError>{failure(github.error, t)}</FieldError>;
  }
  const link = (key: SectionKey) => (
    <SideNavLink
      key={key}
      href={`#${SECTION[key]}`}
      current={current === SECTION[key] ? "location" : undefined}
      onClick={(event) => {
        // Stay off the URL hash: the router owns the location.
        event.preventDefault();
        const target = document.getElementById(SECTION[key]);
        target?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
        });
        target?.focus({ preventScroll: true });
        jumped.current = SECTION[key];
        setCurrent(SECTION[key]);
      }}
    >
      {t(SECTION_LABEL[key])}
    </SideNavLink>
  );
  const here = keys.find((key) => SECTION[key] === current);
  return (
    <>
      <SideNavLayout
        nav={
          <SideNav
            aria-label={t("agentGitHub.sectionNav")}
            className={fits ? "lg:hidden" : undefined}
            current={here ? t(SECTION_LABEL[here]) : undefined}
            onPick={() =>
              document
                .getElementById(jumped.current ?? "")
                ?.focus({ preventScroll: true })
            }
          >
            <SideNavGroup>
              {keys.filter((k) => k !== "push" && k !== "activity").map(link)}
            </SideNavGroup>
            <SideNavGroup label={t("agentGitHub.manage")}>
              {keys.filter((k) => k === "push" || k === "activity").map(link)}
            </SideNavGroup>
          </SideNav>
        }
      >
        <div ref={watchPage} className="flex flex-col gap-8">
          <GitHubSettings
            agentId={agentId}
            detail={detail}
            data={github.data}
            notify={notify}
            sectionKeys={sectionKeys}
          />
        </div>
      </SideNavLayout>
      {toast}
    </>
  );
}

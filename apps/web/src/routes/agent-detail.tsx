import type {
  ActivateAgentResponse,
  AgentCard,
  AgentDetail,
  AgentRelease,
  AgentVersion,
  CreateAgentReleaseResponse,
  ProfileSummary,
} from "@agent-platform/contracts";
import { formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import { agentQuery, profilesQuery, queryKeys } from "../api/queries.ts";
import { useRole } from "../auth/guard.tsx";
import { AgentAdmins } from "../components/agent-admins.tsx";
import {
  AgentCardFields,
  type CardDraft,
  cardFromDraft,
  draftFromCard,
} from "../components/agent-card-form.tsx";
import { TextField } from "../components/field.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { RevisionDiff } from "../components/revision-diff.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";
import { agentRefusal } from "./agents.tsx";

export interface AgentSearch {
  readonly notice?: "created";
}

export function agentSearch(search: Record<string, unknown>): AgentSearch {
  return search.notice === "created" ? { notice: "created" } : {};
}

type Place = "page" | "card" | "releases" | "admins";

/** An outcome shows in the section whose button caused it. */
interface Placed {
  readonly at: Place;
  readonly outcome: Outcome;
}

/** What the screen showed when its activation lost the race. */
interface Conflict {
  readonly seenRevision: number;
  readonly seenActiveReleaseId: string | null;
}

const latestVersion = (detail: AgentDetail) =>
  detail.versions.reduce<AgentVersion | undefined>(
    (latest, version) =>
      latest && latest.version_no > version.version_no ? latest : version,
    undefined,
  );

export function AgentDetailScreen() {
  const { id } = useParams({ from: "/authed/agents/$id" });
  // The route component is reused between agents; a fresh page per id keeps
  // one agent's unsaved edits from being saved onto another.
  return <AgentDetailPage key={id} id={id} />;
}

function AgentDetailPage({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const search = useSearch({ from: "/authed/agents/$id" });
  const { client } = useServices();
  const detail = useQuery(agentQuery(client, id));
  const [placed, setPlaced] = useState<Placed | null>(() =>
    search.notice === "created"
      ? { at: "page", outcome: { kind: "notice", text: t("agent.created") } }
      : null,
  );

  if (detail.isPending) return <StatusScreen kind="loading" />;
  if (detail.error) {
    return isApiError(detail.error, "FORBIDDEN") ? (
      <StatusScreen kind="forbidden" detail={detail.error.message} />
    ) : (
      <LoadFailure error={detail.error} onRetry={() => void detail.refetch()} />
    );
  }
  return (
    <AgentView
      detail={detail.data}
      placed={placed}
      onPlaced={setPlaced}
      onReload={() => detail.refetch()}
    />
  );
}

function AgentView({
  detail,
  placed,
  onPlaced,
  onReload,
}: {
  readonly detail: AgentDetail;
  readonly placed: Placed | null;
  readonly onPlaced: (placed: Placed | null) => void;
  readonly onReload: () => void;
}) {
  const { t } = useI18n();
  const outcomeAt = (at: Place) => (outcome: Outcome | null) =>
    onPlaced(outcome ? { at, outcome } : null);
  const onOutcome = outcomeAt("releases");
  // Until a version is picked or saved the release form offers the latest.
  const [releaseVersion, setReleaseVersion] = useState<string | null>(null);
  const { client, queryClient } = useServices();
  const role = useRole();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const { agent } = detail;
  const versionNo = (versionId: string) =>
    detail.versions.find((version) => version.id === versionId)?.version_no;
  const releaseLabel = (releaseId: string | null) => {
    const release = detail.releases.find((r) => r.id === releaseId);
    return release
      ? t("agent.releaseLabel", {
          version: versionNo(release.version_id) ?? "?",
          profile: release.runtime_profile_id,
        })
      : t("agent.noActive");
  };

  const activate = useMutation<
    ActivateAgentResponse,
    ApiError,
    { release: AgentRelease; expected: number; seenActive: string | null }
  >({
    mutationFn: ({ release, expected }) =>
      unwrap(
        client.POST("/v1/agents/{id}/activate", {
          params: { path: { id: agent.id } },
          body: { release_id: release.id, expected_revision: expected },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      setConflict(null);
      onOutcome({
        kind: "notice",
        text:
          result.receipt_id === null
            ? t("agent.alreadyActive")
            : t("agent.activated", {
                release: releaseLabel(result.active_release_id),
              }),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.agents });
    },
    onError: (error, { expected, seenActive }) => {
      // Someone else moved the pointer since this page loaded. Retrying with
      // a fresh revision would silently undo their choice, so stop and let
      // the person look at what changed first.
      if (error.code === "REVISION_CONFLICT") {
        setConflict({
          seenRevision: expected,
          seenActiveReleaseId: seenActive,
        });
        return;
      }
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) });
    },
  });

  const seenRelease = detail.releases.find(
    (release) => release.id === conflict?.seenActiveReleaseId,
  );
  const reloaded =
    conflict !== null && agent.activation_revision !== conflict.seenRevision;

  return (
    <div className="web-page">
      <div className="web-page__head">
        <h1 className="web-page__title">{agent.name}</h1>
        <span
          className="web-badge"
          data-tone={agent.active_release_id ? "ok" : "pending"}
        >
          {agent.active_release_id
            ? t(`agents.status.${agent.status}`)
            : t("agents.state.notReleased")}
        </span>
      </div>
      <p className="web-table__secondary">
        {t("agents.slugLine", { slug: agent.slug })}
        {/* Without one, the badge already says so. */}
        {agent.active_release_id
          ? ` · ${t("agent.activeRelease", {
              release: releaseLabel(agent.active_release_id),
            })}`
          : null}
      </p>
      <OutcomeLine outcome={placed?.at === "page" ? placed.outcome : null} />
      <CardEditor
        detail={detail}
        result={<PlacedOutcome placed={placed} at="card" />}
        onOutcome={outcomeAt("card")}
        onSaved={setReleaseVersion}
      />
      <VersionHistory
        key={`${latestVersion(detail)?.id}:${agent.active_release_id}`}
        detail={detail}
      />
      <Releases
        detail={detail}
        picked={releaseVersion}
        onPick={setReleaseVersion}
        versionNo={versionNo}
        result={
          <>
            <PlacedOutcome placed={placed} at="releases" />
            <TakesFocus on={conflict}>
              {conflict ? (
                <section
                  className="web-status"
                  data-status="conflict"
                  role="alert"
                >
                  <h3 className="web-status__title">
                    {t("agent.conflict.title")}
                  </h3>
                  <p className="web-status__body">
                    {reloaded
                      ? t("agent.conflict.reloaded", {
                          seen: releaseLabel(conflict.seenActiveReleaseId),
                          now: releaseLabel(agent.active_release_id),
                        })
                      : t("agent.conflict.body")}
                  </p>
                  {reloaded ? (
                    <RevisionDiff
                      before={
                        detail.versions.find(
                          (v) => v.id === seenRelease?.version_id,
                        )?.card ?? null
                      }
                      after={
                        detail.active_release
                          ? (detail.versions.find(
                              (v) => v.id === detail.active_release?.version_id,
                            )?.card ?? null)
                          : null
                      }
                      beforeLabel={releaseLabel(conflict.seenActiveReleaseId)}
                      afterLabel={releaseLabel(agent.active_release_id)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="ap-button"
                      onClick={onReload}
                    >
                      {t("agent.conflict.reload")}
                    </button>
                  )}
                </section>
              ) : null}
            </TakesFocus>
          </>
        }
        onOutcome={onOutcome}
        activating={
          activate.isPending ? activate.variables?.release.id : undefined
        }
        onActivate={(release) =>
          activate.mutate({
            release,
            expected: agent.activation_revision,
            seenActive: agent.active_release_id,
          })
        }
      />
      <AgentAdmins agentId={agent.id} onOutcome={outcomeAt("admins")} />
      <PlacedOutcome placed={placed} at="admins" />
    </div>
  );
}

/** The outcome placed here, focused so the result is where the person is. */
function PlacedOutcome({
  placed,
  at,
}: {
  readonly placed: Placed | null;
  readonly at: Place;
}) {
  const outcome = placed?.at === at ? placed.outcome : null;
  return (
    <TakesFocus on={outcome}>
      <OutcomeLine outcome={outcome} />
    </TakesFocus>
  );
}

/** Each new non-null `on` moves focus to what it wraps. */
function TakesFocus({
  on,
  children,
}: {
  readonly on: unknown;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (on) ref.current?.focus();
  }, [on]);
  return on ? (
    <div ref={ref} tabIndex={-1}>
      {children}
    </div>
  ) : null;
}

function CardEditor({
  detail,
  result,
  onOutcome,
  onSaved,
}: {
  readonly detail: AgentDetail;
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  /** The version the save resolved to, which the release form then offers. */
  readonly onSaved: (versionId: string) => void;
}) {
  const { t } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const latest = latestVersion(detail);
  // The edit is tied to the version it started from, not to whatever a
  // background refetch last brought in, so unsaved input is never replaced.
  const [edit, setEdit] = useState(() => startEdit(detail));
  const base = detail.versions.find((v) => v.id === edit.baseId);
  const dirty =
    edit.name !== edit.baseName ||
    JSON.stringify(edit.draft) !==
      JSON.stringify(base ? draftFromCard(base.card) : null);
  const stale = (latest?.id ?? null) !== edit.seenLatestId;
  if ((stale || detail.agent.name !== edit.baseName) && !dirty)
    setEdit(startEdit(detail));
  const setName = (name: string) => setEdit((e) => ({ ...e, name }));
  const setDraft = (draft: CardDraft) => setEdit((e) => ({ ...e, draft }));
  const { name, draft } = edit;
  const catalog = useQuery(profilesQuery(client));
  const titleId = useId();

  const save = useMutation<AgentDetail, ApiError, Edit>({
    mutationFn: ({ baseName, name, draft }) =>
      unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: {
            path: { id: detail.agent.id },
          },
          body: {
            // Only a name the user changed: sending the one the edit started
            // from would undo a rename made elsewhere since.
            ...(name.trim() !== baseName ? { name: name.trim() } : {}),
            ...(draft ? { card: cardFromDraft(draft, base?.card) } : {}),
          },
        }),
      ) as Promise<AgentDetail>,
    onMutate: () => onOutcome(null),
    onSuccess: async (updated, submitted) => {
      // The server keeps one version per card content, so the card just saved
      // may be an older version rather than the highest one.
      const saved = savedVersion(detail, updated, submitted);
      if (saved) onSaved(saved.id);
      const isNew =
        saved !== undefined && !detail.versions.some((v) => v.id === saved.id);
      onOutcome({
        kind: "notice",
        text: isNew
          ? t("agent.saved", { version: saved.version_no })
          : saved && saved.id !== submitted.baseId
            ? t("agent.savedExisting", { version: saved.version_no })
            : t("agent.savedNoChange"),
      });
      // Input typed while the request was in flight stays; it is now an edit
      // of the version just saved.
      setEdit((current) =>
        sameEdit(current, submitted)
          ? startEdit(updated, saved)
          : {
              ...current,
              baseId: saved?.id ?? null,
              seenLatestId: latestVersion(updated)?.id ?? null,
              baseName: updated.agent.name,
            },
      );
      queryClient.setQueryData(queryKeys.agent(detail.agent.id), updated);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agents,
        exact: true,
      });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(edit);
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agent.card.title")}</h2>
      <p className="web-page__empty">{t("agent.card.intro")}</p>
      {stale && latest ? (
        <div className="web-notice">
          <output>
            {t("agent.card.stale", { version: latest.version_no })}
          </output>
          <button
            type="button"
            className="ap-button"
            onClick={() => setEdit(startEdit(detail))}
          >
            {t("agent.card.takeLatest")}
          </button>
        </div>
      ) : null}
      <form className="web-form web-form--wide" onSubmit={submit}>
        <TextField
          label={t("agents.name")}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {draft ? (
          <AgentCardFields
            draft={draft}
            catalog={catalog}
            onChange={setDraft}
          />
        ) : null}
        <button
          type="submit"
          className="ap-button ap-button--primary"
          disabled={save.isPending || (draft !== null && !catalog.isSuccess)}
        >
          {save.isPending ? t("agent.card.saving") : t("agent.card.save")}
        </button>
      </form>
      {result}
    </section>
  );
}

interface Edit {
  readonly baseId: string | null;
  /** The newest version when the edit started; a newer one means another save. */
  readonly seenLatestId: string | null;
  readonly baseName: string;
  readonly name: string;
  readonly draft: CardDraft | null;
}

const sameEdit = (a: Edit, b: Edit) =>
  a.name === b.name && JSON.stringify(a.draft) === JSON.stringify(b.draft);

function startEdit(detail: AgentDetail, from?: AgentVersion): Edit {
  const latest = latestVersion(detail);
  const base = from ?? latest;
  return {
    baseId: base?.id ?? null,
    seenLatestId: latest?.id ?? null,
    baseName: detail.agent.name,
    name: detail.agent.name,
    draft: base ? draftFromCard(base.card) : null,
  };
}

function savedVersion(
  before: AgentDetail,
  after: AgentDetail,
  submitted: Edit,
): AgentVersion | undefined {
  const baseCard = before.versions.find((v) => v.id === submitted.baseId)?.card;
  // Both sides go through the same normalisation the request did, rules
  // included, so a card that only differs in what the server trims matches.
  const normal = (draft: CardDraft, card?: AgentCard) =>
    JSON.stringify(cardFromDraft(draft, card));
  const sent = submitted.draft ? normal(submitted.draft, baseCard) : null;
  const matching = after.versions.filter(
    (version) => normal(draftFromCard(version.card), version.card) === sent,
  );
  return (
    latestVersion({ ...after, versions: matching }) ?? latestVersion(after)
  );
}

function VersionHistory({ detail }: { readonly detail: AgentDetail }) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const ordered = [...detail.versions].sort(
    (a, b) => b.version_no - a.version_no,
  );
  const activeVersionId = detail.active_release?.version_id;
  const [afterId, setAfterId] = useState(ordered[0]?.id ?? "");
  const [beforeId, setBeforeId] = useState(
    (activeVersionId && activeVersionId !== ordered[0]?.id
      ? activeVersionId
      : ordered[1]?.id) ?? "",
  );
  const before = ordered.find((version) => version.id === beforeId);
  const after = ordered.find((version) => version.id === afterId);
  const label = (version: AgentVersion) =>
    t("agent.versionLabel", { version: version.version_no });

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agent.versions.title")}</h2>
      <ul className="web-list">
        {ordered.map((version) => (
          <li key={version.id} className="web-list__item">
            <span className="web-table__primary">{label(version)}</span>
            <span className="web-table__secondary">
              {formatTimestamp(version.created_at, locale)}
              {version.id === activeVersionId
                ? ` · ${t("agent.versions.active")}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
      {ordered.length > 1 ? (
        <>
          <div className="web-form web-form--inline">
            <VersionSelect
              label={t("agent.versions.before")}
              versions={ordered}
              value={beforeId}
              onChange={setBeforeId}
            />
            <VersionSelect
              label={t("agent.versions.after")}
              versions={ordered}
              value={afterId}
              onChange={setAfterId}
            />
          </div>
          {before && after ? (
            <RevisionDiff
              before={before.card}
              after={after.card}
              beforeLabel={label(before)}
              afterLabel={label(after)}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function VersionSelect({
  label,
  versions,
  value,
  onChange,
}: {
  readonly label: string;
  readonly versions: readonly AgentVersion[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <label className="web-field">
      <span>{label}</span>
      <select
        className="ap-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {versions.map((version) => (
          <option key={version.id} value={version.id}>
            {t("agent.versionLabel", { version: version.version_no })}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProfileSelect({
  label,
  hint,
  profiles,
  cardModel,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly profiles: readonly ProfileSummary[];
  readonly cardModel: string | undefined;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  const hintId = useId();
  return (
    <div className="web-field">
      <label className="web-field">
        <span>{label}</span>
        <select
          className="ap-input"
          required
          value={value}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {t(
                cardModel !== undefined && profile.model !== cardModel
                  ? "agent.releases.profileOptionMismatch"
                  : "agent.releases.profileOption",
                { profile: profile.id, model: profile.model },
              )}
            </option>
          ))}
        </select>
      </label>
      <span id={hintId} className="web-field__hint">
        {hint}
      </span>
    </div>
  );
}

function Releases({
  detail,
  picked,
  onPick,
  versionNo,
  result,
  onOutcome,
  activating,
  onActivate,
}: {
  readonly detail: AgentDetail;
  /** The version to release; null offers the latest. */
  readonly picked: string | null;
  readonly onPick: (versionId: string) => void;
  readonly versionNo: (versionId: string) => number | undefined;
  /** Release and activation results, between the form and the list. */
  readonly result: ReactNode;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly activating: string | undefined;
  readonly onActivate: (release: AgentRelease) => void;
}) {
  const { t, locale } = useI18n();
  const { client, queryClient } = useServices();
  const role = useRole();
  const titleId = useId();
  const latest = latestVersion(detail);
  const versionId = picked ?? latest?.id ?? "";
  const profiles = useQuery(profilesQuery(client));
  const [chosen, setProfile] = useState(
    detail.releases.at(-1)?.runtime_profile_id ?? "",
  );
  const cardModel = detail.versions.find((v) => v.id === versionId)?.card.model;
  // A profile the catalog no longer has cannot be released again; without
  // a usable choice, offer one that runs the card's model.
  const items = profiles.data?.items ?? [];
  const profile = items.some((item) => item.id === chosen)
    ? chosen
    : ((items.find((item) => item.model === cardModel) ?? items[0])?.id ?? "");
  const ordered = [...detail.releases].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  // The server refuses a release whose profile runs another model than the
  // card names; say so before the request.
  const profileModel = items.find((item) => item.id === profile)?.model;
  const mismatch =
    cardModel !== undefined &&
    profileModel !== undefined &&
    cardModel !== profileModel;

  const release = useMutation<CreateAgentReleaseResponse, ApiError>({
    mutationFn: () =>
      unwrap(
        client.POST("/v1/agents/{id}/releases", {
          params: { path: { id: detail.agent.id } },
          body: { version_id: versionId, runtime_profile_id: profile },
        }),
      ),
    onMutate: () => onOutcome(null),
    onSuccess: async (result) => {
      onOutcome({
        kind: "notice",
        text: result.created
          ? t("agent.releaseCreated", {
              version: versionNo(result.release.version_id) ?? "?",
            })
          : t("agent.releaseExisted"),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.agent(detail.agent.id),
      });
    },
    onError: (error) =>
      onOutcome({ kind: "error", text: agentRefusal(t, error, role) }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    release.mutate();
  };

  return (
    <section className="web-section" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("agent.releases.title")}</h2>
      <p className="web-page__empty">{t("agent.releases.intro")}</p>
      <form className="web-form web-form--inline" onSubmit={submit}>
        <VersionSelect
          label={t("agent.releases.version")}
          versions={[...detail.versions].sort(
            (a, b) => b.version_no - a.version_no,
          )}
          value={versionId}
          onChange={onPick}
        />
        {profiles.isPending ? (
          <p className="web-page__empty">
            {t("agent.releases.profilesLoading")}
          </p>
        ) : profiles.error ? (
          <p className="web-form__error" role="alert">
            {t("agent.releases.profilesFailed", {
              reason: t(errorKey((profiles.error as ApiError).code)),
            })}
          </p>
        ) : (
          <ProfileSelect
            label={t("agent.releases.profile")}
            hint={t("agent.releases.profileHint")}
            profiles={items}
            cardModel={cardModel}
            value={profile}
            onChange={setProfile}
          />
        )}
        {mismatch ? (
          <output className="web-notice">
            {t("agent.releases.modelMismatch", {
              card: cardModel,
              profile: profileModel,
            })}
          </output>
        ) : null}
        <button
          type="submit"
          className="ap-button"
          disabled={release.isPending || versionId === "" || profile === ""}
        >
          {release.isPending
            ? t("agent.releases.creating")
            : t("agent.releases.create")}
        </button>
      </form>
      {result}
      {ordered.length === 0 ? (
        <p className="web-page__empty">{t("agent.releases.empty")}</p>
      ) : (
        <ul className="web-list">
          {ordered.map((item) => {
            const active = item.id === detail.agent.active_release_id;
            const label = t("agent.releaseLabel", {
              version: versionNo(item.version_id) ?? "?",
              profile: item.runtime_profile_id,
            });
            return (
              <li key={item.id} className="web-list__item" data-active={active}>
                <span>
                  <span className="web-table__primary">{label}</span>
                  <span className="web-table__secondary">
                    {formatTimestamp(item.created_at, locale)} ·{" "}
                    {item.approved_at
                      ? t("agent.releases.approved", {
                          at: formatTimestamp(item.approved_at, locale),
                        })
                      : t("agent.releases.notApproved")}
                  </span>
                </span>
                {active ? (
                  <span className="web-badge" data-tone="ok">
                    {t("agent.releases.active")}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="ap-button"
                    disabled={activating !== undefined}
                    aria-label={t("agent.releases.activateFor", {
                      release: label,
                    })}
                    onClick={() => onActivate(item)}
                  >
                    {activating === item.id
                      ? t("agent.releases.activating")
                      : t("agent.releases.activate")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

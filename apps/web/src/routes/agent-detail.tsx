import type { AgentDetail, AgentVersion } from "@agent-platform/contracts";
import { formatTimestamp } from "@agent-platform/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useSearch } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { type ApiError, isApiError, unwrap } from "../api/client.ts";
import { agentQuery, queryKeys } from "../api/queries.ts";
import { useRole } from "../auth/guard.tsx";
import {
  AgentCardFields,
  type CardDraft,
  cardFromDraft,
  draftFromCard,
} from "../components/agent-card-form.tsx";
import { TextField } from "../components/field.tsx";
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

type Outcome =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

const latestVersion = (detail: AgentDetail) =>
  detail.versions.reduce<AgentVersion | undefined>(
    (latest, version) =>
      latest && latest.version_no > version.version_no ? latest : version,
    undefined,
  );

export function AgentDetailScreen() {
  const { t } = useI18n();
  const { id } = useParams({ from: "/authed/agents/$id" });
  const search = useSearch({ from: "/authed/agents/$id" });
  const { client } = useServices();
  const detail = useQuery(agentQuery(client, id));
  const [outcome, setOutcome] = useState<Outcome | null>(() =>
    search.notice === "created"
      ? { kind: "notice", text: t("agent.created") }
      : null,
  );

  if (detail.isPending) return <StatusScreen kind="loading" />;
  if (detail.error) {
    return isApiError(detail.error, "FORBIDDEN") ? (
      <StatusScreen kind="forbidden" detail={detail.error.message} />
    ) : (
      <p className="web-form__error" role="alert">
        {t(errorKey((detail.error as ApiError).code))}
      </p>
    );
  }
  return (
    <AgentView detail={detail.data} outcome={outcome} onOutcome={setOutcome} />
  );
}

function AgentView({
  detail,
  outcome,
  onOutcome,
}: {
  readonly detail: AgentDetail;
  readonly outcome: Outcome | null;
  readonly onOutcome: (outcome: Outcome | null) => void;
}) {
  const { t } = useI18n();
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
        {agent.slug} ·{" "}
        {t("agent.activeRelease", {
          release: releaseLabel(agent.active_release_id),
        })}
      </p>
      {outcome ? (
        outcome.kind === "error" ? (
          <p className="web-form__error" role="alert">
            {outcome.text}
          </p>
        ) : (
          <output className="web-notice">{outcome.text}</output>
        )
      ) : null}
      <CardEditor detail={detail} onOutcome={onOutcome} />
      <VersionHistory
        key={`${latestVersion(detail)?.id}:${agent.active_release_id}`}
        detail={detail}
      />
    </div>
  );
}

function CardEditor({
  detail,
  onOutcome,
}: {
  readonly detail: AgentDetail;
  readonly onOutcome: (outcome: Outcome | null) => void;
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
    edit.name !== detail.agent.name ||
    JSON.stringify(edit.draft) !==
      JSON.stringify(base ? draftFromCard(base.card) : null);
  const stale = (latest?.id ?? null) !== edit.baseId;
  if (stale && !dirty) setEdit(startEdit(detail));
  const setName = (name: string) => setEdit((e) => ({ ...e, name }));
  const setDraft = (draft: CardDraft) => setEdit((e) => ({ ...e, draft }));
  const { name, draft } = edit;
  const titleId = useId();

  const save = useMutation<AgentDetail, ApiError>({
    mutationFn: () =>
      unwrap(
        client.PATCH("/v1/agents/{id}", {
          params: {
            path: { id: detail.agent.id },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
          body: {
            ...(name.trim() !== detail.agent.name ? { name: name.trim() } : {}),
            ...(draft ? { card: cardFromDraft(draft, base?.card) } : {}),
          },
        }),
      ) as Promise<AgentDetail>,
    onMutate: () => onOutcome(null),
    onSuccess: async (updated) => {
      const saved = latestVersion(updated);
      onOutcome({
        kind: "notice",
        text:
          saved && saved.id !== edit.baseId
            ? t("agent.saved", { version: saved.version_no })
            : t("agent.savedNoChange"),
      });
      setEdit(startEdit(updated));
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
    save.mutate();
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
        {draft ? <AgentCardFields draft={draft} onChange={setDraft} /> : null}
        <button
          type="submit"
          className="ap-button ap-button--primary"
          disabled={save.isPending}
        >
          {save.isPending ? t("agent.card.saving") : t("agent.card.save")}
        </button>
      </form>
    </section>
  );
}

function startEdit(detail: AgentDetail) {
  const latest = latestVersion(detail);
  return {
    baseId: latest?.id ?? null,
    name: detail.agent.name,
    draft: latest ? draftFromCard(latest.card) : null,
  };
}

function VersionHistory({ detail }: { readonly detail: AgentDetail }) {
  const { t } = useI18n();
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
              {formatTimestamp(version.created_at)} ·{" "}
              {version.content_sha256.slice(0, 12)}
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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  ActivateAgentResponse,
  AgentDetail,
  AgentRelease,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import { useRef, useState } from "react";
import { agentQuery, queryKeys } from "../api/queries.ts";
import { useRole } from "../auth/guard.tsx";
import { AgentAdmins } from "../components/agent-admins.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { type Outcome, OutcomeLine } from "../components/outcome.tsx";
import { RevisionDiff } from "../components/revision-diff.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { CardEditor } from "./agent-detail/card-editor.tsx";
import {
  Credentials,
  CredentialUnbound,
  unboundRefs,
} from "./agent-detail/credentials.tsx";
import {
  type Place,
  type Placed,
  PlacedOutcome,
  TakesFocus,
} from "./agent-detail/placement.tsx";
import { Releases } from "./agent-detail/releases.tsx";
import { VersionHistory } from "./agent-detail/version-history.tsx";
import { latestVersion } from "./agent-detail/versions.tsx";
import { agentRefusal } from "./agents.tsx";

export interface AgentSearch {
  readonly notice?: "created";
}

export function agentSearch(search: Record<string, unknown>): AgentSearch {
  return search.notice === "created" ? { notice: "created" } : {};
}

/** What the screen showed when its activation lost the race. */
interface Conflict {
  readonly seenRevision: number;
  readonly seenActiveReleaseId: string | null;
}

export function AgentDetailScreen() {
  const { id } = useParams({ from: "/authed/agents/$id" });
  // The route component is reused between agents; a fresh page per id keeps
  // one agent's unsaved edits from being saved onto another.
  return <AgentDetailPage key={id} id={id} />;
}

function AgentDetailPage({ id }: { readonly id: string }) {
  const { t } = useI18n();
  const search = useSearch({ from: "/authed/agents/$id" });
  const { client } = useAgentPlatform();
  const detail = useQuery(agentQuery(client, id));
  const [placed, setPlaced] = useState<Placed | null>(() =>
    search.notice === "created"
      ? { at: "page", outcome: { kind: "notice", text: t("agent.created") } }
      : null,
  );

  if (detail.isPending) return <StatusScreen kind="loading" />;
  if (detail.error) {
    // One page for both, so a refusal does not confirm the agent exists.
    return isApiError(detail.error, "FORBIDDEN") ||
      isApiError(detail.error, "NOT_FOUND") ? (
      <AgentNotFound />
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

function AgentNotFound() {
  const { t } = useI18n();
  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("agent.notFound.title")}</h1>
      <p className="web-page__intro">{t("agent.notFound.body")}</p>
      <Link className="ap-button" to="/agents">
        {t("agent.notFound.back")}
      </Link>
    </div>
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
  const { client } = useAgentPlatform();
  const queryClient = useQueryClient();
  const role = useRole();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // The names the last refused activation found unbound.
  const [unbound, setUnbound] = useState<readonly string[] | null>(null);
  const credentialsTitle = useRef<HTMLHeadingElement>(null);
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
    onMutate: () => {
      onOutcome(null);
      setUnbound(null);
    },
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
      const missing = unboundRefs(error);
      if (missing) {
        setUnbound(missing);
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
      <Credentials
        detail={detail}
        missing={unbound ?? []}
        titleRef={credentialsTitle}
        result={<PlacedOutcome placed={placed} at="credentials" />}
        onOutcome={outcomeAt("credentials")}
      />
      <Releases
        detail={detail}
        picked={releaseVersion}
        onPick={setReleaseVersion}
        versionNo={versionNo}
        result={
          <>
            <PlacedOutcome placed={placed} at="releases" />
            <TakesFocus on={unbound}>
              {unbound ? (
                <CredentialUnbound
                  missing={unbound}
                  onGo={() => credentialsTitle.current?.focus()}
                />
              ) : null}
            </TakesFocus>
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

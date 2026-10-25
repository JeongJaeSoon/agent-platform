import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { type ApiError, isApiError, unwrap } from "@werft-ai/client";
import type {
  ActivateAgentResponse,
  AgentDetail,
  AgentRelease,
} from "@werft-ai/contracts";
import { useAgentPlatform } from "@werft-ai/react";
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  buttonVariants,
  Page,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { agentQuery, queryKeys } from "../api/queries.ts";
import { useRole } from "../auth/guard.tsx";
import { ReasonButton } from "../auth/reason-button.tsx";
import { AgentAdmins } from "../components/agent-admins.tsx";
import { AgentAvatar } from "../components/agent-cards.tsx";
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
  AgentGlance,
  AgentReadiness,
  AgentRecentSessions,
  CardSummary,
} from "./agent-detail/overview.tsx";
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

// Console v4: 24px under the tabs, sections 32px apart.
const PANEL = "@container flex flex-col gap-8 pt-2";

const SlackTab = lazy(() => import("./agent-detail/slack.tsx"));

export const AGENT_TABS = [
  "overview",
  "card",
  "release",
  "admins",
  "slack",
] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export interface AgentSearch {
  readonly notice?: "created";
  /** Absent for the overview, so a plain agent link opens it. */
  readonly tab?: Exclude<AgentTab, "overview">;
}

export function agentSearch(search: Record<string, unknown>): AgentSearch {
  const tab = AGENT_TABS.find(
    (name) => name !== "overview" && name === search.tab,
  ) as AgentSearch["tab"];
  return {
    ...(search.notice === "created" ? { notice: "created" as const } : {}),
    ...(tab ? { tab } : {}),
  };
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
    <Page
      title={t("agent.notFound.title")}
      description={t("agent.notFound.body")}
    >
      <Link
        className={buttonVariants({
          variant: "outline",
          className: "self-start",
        })}
        to="/agents"
      >
        {t("agent.notFound.back")}
      </Link>
    </Page>
  );
}

/** The tab holding each section a result is placed in. */
const PLACE_TAB = {
  page: undefined,
  card: "card",
  credentials: "release",
  releases: "release",
  admins: "admins",
} as const satisfies Record<Place, AgentTab | undefined>;

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
  // Validated again: the root route passes the raw query through, so an
  // unknown `tab` still reaches this route's search.
  const urlTab: AgentTab =
    agentSearch(useSearch({ from: "/authed/agents/$id" })).tab ?? "overview";
  // Held here as well, because the URL settles a render later: a result
  // opening its tab must be visible in the same render that focuses it.
  const [tab, setTab] = useState(urlTab);
  const [slackOpened, setSlackOpened] = useState(urlTab === "slack");
  useEffect(() => {
    if (tab === "slack") setSlackOpened(true);
  }, [tab]);
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTab(urlTab);
  }
  const navigate = useNavigate({ from: "/agents/$id" });
  // Replace, not push: arrowing across the tabs would otherwise fill the
  // back button with tab entries.
  const openTab = (next: AgentTab) => {
    setTab(next);
    void navigate({
      search: ({ tab: _, ...rest }) =>
        next === "overview" ? rest : { ...rest, tab: next },
      replace: true,
    });
  };
  const outcomeAt = (at: Place) => (outcome: Outcome | null) => {
    onPlaced(outcome ? { at, outcome } : null);
    // A request can finish after the person moved to another tab.
    const home = PLACE_TAB[at];
    if (outcome && home) openTab(home);
  };
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
        openTab("release");
        return;
      }
      const missing = unboundRefs(error, detail);
      if (missing) {
        setUnbound(missing);
        openTab("release");
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

  const tabLabel = (name: AgentTab) => t(`agent.tabs.${name}`);
  // Every panel stays mounted, so leaving a tab never drops an unsaved card;
  // Radix leaves a force-mounted panel visible and in the tab order.
  const tabPanel = (name: AgentTab) => ({
    value: name,
    forceMount: true as const,
    hidden: name !== tab,
    tabIndex: name === tab ? 0 : -1,
    className: PANEL,
  });
  const releaseTab = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  // Closing the editor hands the keyboard back to the button that opened it.
  const editReturns = useRef(false);
  useEffect(() => {
    if (!editing && editReturns.current) {
      editReturns.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  // The tab it opens is where the keyboard goes next, not this button.
  const toRelease = (
    <Button
      type="button"
      variant="outline"
      className="self-start"
      onClick={() => {
        openTab("release");
        releaseTab.current?.focus();
      }}
    >
      {t("agent.tabs.toRelease")}
    </Button>
  );

  const body = (
    <Tabs
      value={tab}
      onValueChange={(next) => openTab(next as AgentTab)}
      className="min-w-0 gap-[var(--ap-space-block)]"
    >
      <div className="border-b">
        <TabsList variant="line" aria-label={t("agent.tabs.label")}>
          {AGENT_TABS.map((name) => (
            <TabsTrigger
              key={name}
              value={name}
              ref={name === "release" ? releaseTab : undefined}
            >
              {tabLabel(name)}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent {...tabPanel("overview")}>
        <AgentGlance detail={detail} />
        <AgentReadiness detail={detail} toRelease={toRelease} />
        <AgentRecentSessions />
      </TabsContent>
      <TabsContent {...tabPanel("card")}>
        {/* The panel stays mounted, so an open editor keeps its input across tabs. */}
        {editing ? (
          <CardEditor
            detail={detail}
            result={<PlacedOutcome placed={placed} at="card" />}
            onOutcome={outcomeAt("card")}
            onSaved={setReleaseVersion}
            onClose={(cancelled) => {
              setEditing(false);
              editReturns.current = cancelled;
            }}
          />
        ) : (
          <>
            <CardSummary
              detail={detail}
              edit={
                <Button
                  ref={editButton}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  {t("agent.card.edit")}
                </Button>
              }
            />
            {placed?.at === "card" ? (
              <div className="flex flex-col gap-3">
                <PlacedOutcome placed={placed} at="card" />
                {placed.outcome.kind === "notice" ? toRelease : null}
              </div>
            ) : null}
          </>
        )}
        <VersionHistory
          key={`${latestVersion(detail)?.id}:${agent.active_release_id}`}
          detail={detail}
        />
      </TabsContent>
      <TabsContent {...tabPanel("release")}>
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
                  <Alert
                    asChild
                    variant="red"
                    data-status="conflict"
                    role="alert"
                  >
                    <section>
                      <AlertTitle asChild>
                        <h3 className="m-0">{t("agent.conflict.title")}</h3>
                      </AlertTitle>
                      <AlertDescription>
                        {reloaded
                          ? t("agent.conflict.reloaded", {
                              seen: releaseLabel(conflict.seenActiveReleaseId),
                              now: releaseLabel(agent.active_release_id),
                            })
                          : t("agent.conflict.body")}
                      </AlertDescription>
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
                                  (v) =>
                                    v.id === detail.active_release?.version_id,
                                )?.card ?? null)
                              : null
                          }
                          beforeLabel={releaseLabel(
                            conflict.seenActiveReleaseId,
                          )}
                          afterLabel={releaseLabel(agent.active_release_id)}
                        />
                      ) : (
                        <AlertActions>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={onReload}
                          >
                            {t("agent.conflict.reload")}
                          </Button>
                        </AlertActions>
                      )}
                    </section>
                  </Alert>
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
      </TabsContent>
      <TabsContent {...tabPanel("admins")}>
        <AgentAdmins agentId={agent.id} onOutcome={outcomeAt("admins")} />
        <PlacedOutcome placed={placed} at="admins" />
      </TabsContent>
      <TabsContent {...tabPanel("slack")}>
        {tab === "slack" || slackOpened ? (
          <Suspense
            fallback={
              <div
                className="min-h-96 animate-pulse rounded-lg bg-muted"
                aria-busy="true"
              />
            }
          >
            <SlackTab
              agentId={agent.id}
              slug={agent.slug}
              active={agent.active_release_id !== null}
            />
          </Suspense>
        ) : null}
      </TabsContent>
    </Tabs>
  );

  const cardRole = latestVersion(detail)?.card.role;
  return (
    <Page
      // As on a session's page: narrow, the commands go under the title.
      // Below 1024 the two buttons leave the name too little room to keep
      // its tag beside it, so they go under the title, the way back at the
      // row's right end.
      headClassName="max-lg:flex-col max-lg:items-stretch"
      title={
        <span className="flex min-w-0 items-center gap-3">
          <AgentAvatar name={agent.name} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{agent.name}</span>
        </span>
      }
      titleAside={
        <Badge
          variant={
            agent.active_release_id && agent.status === "active"
              ? "green"
              : "gray"
          }
        >
          {agent.active_release_id
            ? t(`agents.status.${agent.status}`)
            : t("agents.state.notReleased")}
        </Badge>
      }
      // Identifier and release are the overview's.
      description={
        cardRole ? (
          <span className="[overflow-wrap:anywhere]">{cardRole}</span>
        ) : undefined
      }
      actions={
        // The way back ends the row, the command before it.
        <div className="flex flex-1 flex-wrap items-start gap-2">
          <ReasonButton
            className={buttonVariants()}
            reason={t("sessionList.newUnavailable")}
          >
            {t("agent.newSession")}
          </ReasonButton>
          <Link
            to="/agents"
            className={buttonVariants({
              variant: "outline",
              className: "ms-auto",
            })}
          >
            <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
            {t("agent.back")}
          </Link>
        </div>
      }
    >
      <OutcomeLine outcome={placed?.at === "page" ? placed.outcome : null} />
      {body}
    </Page>
  );
}

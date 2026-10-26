import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  ApiKeyView,
  InstallationLimitsResponse,
  ListSessionsResponse,
  SessionSummary,
  UsageSummaryResponse,
} from "@werft-ai/contracts";
import {
  apiKeysQuery,
  pendingRequestsQuery,
  queryKeys,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { useAgentPlatform, useSessions } from "@werft-ai/react";
import { ApprovalInbox, usePendingRail } from "@werft-ai/react/blocks";
import { DetailLayout } from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Card,
  cn,
  formatExactTime,
  formatTimestamp,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Page,
  RelativeTime,
  Skeleton,
  StatusDot,
  type StatusDotStatus,
  Steps,
  Link as TextLink,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import { ArrowRight, Folder, GitBranch, Inbox } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  administeredAgentsQuery,
  agentsQuery,
  firstMembersQuery,
  invitesQuery,
  linkedAccountsQuery,
  myTeamsQuery,
} from "../api/queries.ts";
import { useHasPermission, useMe, useRole } from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { CredentialNeed } from "../components/agent-cards.tsx";
import { AgentStateBadge } from "../components/agent-state.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey,
  type Locale,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";
import { agentState } from "./agents.tsx";
import { expiryState } from "./api-keys.tsx";
import { loadError, useUnavailable } from "./sessions.tsx";
import { duration, usageSummaryQuery } from "./usage.tsx";

/** Done, not yet, or not knowable here (the list refused this viewer, or failed). */
type StepState = "done" | "pending" | "unknown";

interface Step {
  readonly key: MessageKey;
  readonly state: StepState;
  readonly to?: "/members" | "/agents" | "/sessions";
  /** Every step says how it gets done, so every row has the same two lines. */
  readonly hint: MessageKey;
}

function stateOf(query: {
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly data?: boolean | undefined;
}): StepState {
  if (query.isError) return "unknown";
  return query.isSuccess && query.data ? "done" : "pending";
}

const STEP_ACTION = {
  "/members": "home.checklist.toMembers",
  "/agents": "home.checklist.toAgents",
  "/sessions": "home.checklist.toSessions",
} as const satisfies Record<NonNullable<Step["to"]>, MessageKey>;

const RECENT_LIMIT = 5;
const RECENT_COLUMNS =
  "minmax(0,2.2fr) 120px minmax(0,1.2fr) minmax(0,1.2fr) 72px";
// Without the agent and repository columns: the agent is always "—" for now,
// and the title needs the width at 390px.
const RECENT_NARROW_COLUMNS = "minmax(0,1fr) 116px 64px";
const STALE_WAIT_MS = 30 * 60 * 1000;
// Lines the home inbox draws before the rest go to the sessions screen.
const HOME_REQUESTS_LIMIT = 5;
const MINUTE_MS = 60 * 1000;

/**
 * The time, moved on every minute. Polls that return the same data do not
 * re-render, so waits and "x ago" would otherwise stay as first drawn.
 */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The bootstrap checklist until every step is done, then the requests waiting
 * on the viewer, answerable in place, counts with the session that waited
 * longest and the newest sessions. Each checklist step is read from the
 * server: someone was invited once an invite exists or a second member
 * joined, an agent is ready once one has an active release, and a session
 * started once the viewer's own session list has one.
 *
 * The overview cards follow the design canvas. The usage figures cover the
 * last 30 UTC days; a figure no API serves yet (output storage, an agent's
 * own counts) reads "not measured" instead of a number.
 */
export function HomeScreen() {
  const { t, locale } = useI18n();
  const {
    reader,
    agents: managed,
    failure: readerFailure,
    deciding,
  } = useReader();
  const name = useMe()?.user?.display_name ?? "";
  const role = useRole();
  // Every line this role may get, laid over one another: the header holds
  // the tallest from the first render, so telling the reader apart never
  // pushes the body down, however the words wrap.
  const intros: readonly Reader[] =
    role === undefined
      ? []
      : role === "owner" || role === "admin"
        ? [role]
        : ["manager", "requester"];
  const now = useNow();
  const unavailable = useUnavailable();
  const refusal = (error: { readonly code: string }) => t(errorKey(error.code));
  const rail = usePendingRail({
    renderError: loadError,
    unavailable,
    refusal,
  });
  const { client } = useAgentPlatform();
  // The server refuses these lists to anyone else; a member asks for none.
  const managesMembers = useHasPermission("member.manage");
  const managesAgents = useHasPermission("agent.manage");
  const members = useQuery({
    ...firstMembersQuery(client),
    select: (page) => page.items.length > 1,
    enabled: managesMembers,
  });
  const invites = useQuery({
    ...invitesQuery(client),
    select: (page) => page.items.length > 0,
    enabled: managesMembers,
  });
  const agents = useQuery({ ...agentsQuery(client), enabled: managesAgents });
  const sessions = useSessions();
  const waiting = useQuery(waitingSessionsQuery(client));
  // The install's figures are the owner's alone; anyone else would get 403.
  const operator = useHasPermission("usage.installation_read");
  const limits = useQuery({
    queryKey: ["limits"],
    queryFn: () =>
      unwrap(client.GET("/v1/limits")) as Promise<InstallationLimitsResponse>,
    enabled: operator,
    retry: false,
  });
  const since = last30Days(now);
  const myUsage = useQuery(usageSummaryQuery(client, "me", since));
  const installUsage = useQuery({
    ...usageSummaryQuery(client, "installation", since),
    enabled: operator,
  });
  const keys = useQuery(apiKeysQuery(client));
  // Every reader's cards count these; a session without a role has no cards.
  const carded = reader !== undefined;
  const running = useQuery(statusPageQuery(client, "running", carded));
  const idle = useQuery(statusPageQuery(client, "idle", carded));
  const accounts = useQuery({
    ...linkedAccountsQuery(client),
    enabled: carded,
  });
  // Either list can show the step done; to call it not done, both must answer.
  const invited: StepState =
    members.data || invites.data
      ? "done"
      : members.isError || invites.isError
        ? "unknown"
        : stateOf(members);
  const firstPage = sessions.data?.pages[0];
  const steps: readonly Step[] = [
    {
      key: "home.checklist.admin",
      state: "done",
      hint: "home.checklist.adminHint",
    },
    {
      key: "home.checklist.invite",
      state: invited,
      to: "/members",
      hint: "home.checklist.inviteHint",
    },
    {
      key: "home.checklist.agent",
      state: stateOf({
        isSuccess: agents.isSuccess,
        isError: agents.isError,
        data: agents.data?.items.some(
          (agent) => agent.active_release_id !== null,
        ),
      }),
      to: "/agents",
      hint: "home.checklist.agentHint",
    },
    {
      key: "home.checklist.session",
      state: stateOf({
        isSuccess: sessions.isSuccess,
        isError: sessions.isError,
        data: (firstPage?.items.length ?? 0) > 0,
      }),
      to: "/sessions",
      hint: "home.checklist.sessionHint",
    },
  ];

  // Only for those who can do the steps; shown once every list has answered,
  // so it does not flash in and out while loading, and gone once every step
  // is done.
  const checklistShown =
    managesMembers &&
    managesAgents &&
    [members, invites, agents, sessions].every((query) => !query.isPending) &&
    steps.some((step) => step.state !== "done");

  // The oldest request and each session's wait are read from the same
  // per-session lists the session screen reads. They show nothing unless the
  // one page holds every waiting session and every list answered: a partial
  // read would name the wrong request. A failed refetch keeps the old page in
  // data, so the last read must have succeeded.
  const complete = waiting.isSuccess && waiting.data.next_cursor === null;
  const requests = useQueries({
    queries: complete
      ? (waiting.data?.items ?? []).map((session) =>
          pendingRequestsQuery(client, session.id),
        )
      : [],
    combine: (lists) => {
      // No queries also passes every(): only a complete read may count zero.
      if (!complete || !lists.every((list) => list.isSuccess)) return undefined;
      let first: { sessionId: string; at: string } | undefined;
      // A session counts as waiting long once its oldest request is.
      let stale = 0;
      const since: Record<string, string> = {};
      const staleBefore = new Date(now - STALE_WAIT_MS).toISOString();
      lists.forEach((list, index) => {
        const sessionId = waiting.data?.items[index]?.id;
        let sessionFirst: string | undefined;
        for (const request of list.data?.items ?? []) {
          if (!sessionFirst || request.created_at < sessionFirst)
            sessionFirst = request.created_at;
          if (sessionId && (!first || request.created_at < first.at))
            first = { sessionId, at: request.created_at };
        }
        if (sessionId && sessionFirst) since[sessionId] = sessionFirst;
        if (sessionFirst && sessionFirst < staleBefore) stale += 1;
      });
      return { oldest: first, stale, since };
    },
  });
  const oldest = requests?.oldest;
  // The inbox reads each listed session's requests itself; a list still on
  // its way would grow the inbox under the sections below.
  const requestsSettled = useQueries({
    queries: (waiting.data?.items ?? []).map((session) =>
      pendingRequestsQuery(client, session.id),
    ),
    combine: (lists) => lists.every((list) => !list.isLoading),
  });
  const teams = useQuery(myTeamsQuery(client));
  // Which sections show, and how tall the inbox and the cards are,
  // wait on these reads. Until all have answered the body is one
  // placeholder, so nothing drawn early is pushed down when they do. Once
  // shown it stays, through later reads and retries.
  const [settled, setSettled] = useState(false);
  if (
    !settled &&
    requestsSettled &&
    !deciding &&
    [
      members,
      invites,
      agents,
      sessions,
      waiting,
      keys,
      teams,
      myUsage,
      installUsage,
      limits,
      running,
      idle,
      accounts,
    ].every((query) => !query.isLoading)
  )
    setSettled(true);
  const agentItems = agents.data?.items ?? [];
  const activeAgents = agentItems.filter(
    (agent) => agentState(agent) === "active",
  ).length;
  const draftAgents = agentItems.filter(
    (agent) => agentState(agent) === "draft",
  ).length;
  const expiring = (keys.data?.items ?? []).filter(
    (key) => key.revoked_at === null && expiryState(key.expires_at) === "soon",
  );
  const attention =
    requests && keys.isSuccess ? requests.stale + expiring.length : null;
  const unmeasured = <Unmeasured />;
  const unknown = t("home.overview.unknown");
  const number = new Intl.NumberFormat(locale);
  // A partial sum must not pass for the whole spend.
  const costNote = (summary: UsageSummaryResponse | undefined) =>
    t(
      summary && !summary.cost_complete
        ? "home.glance.costPartial"
        : "home.glance.estimatedCost",
    );
  const installSummary = installUsage.isError ? undefined : installUsage.data;
  const mySummary = myUsage.isError ? undefined : myUsage.data;
  const installCard = operator ? (
    <GlanceCard
      key="install"
      eyebrow={t("home.glance.installation")}
      title={t("home.glance.installationTitle")}
      value={installSummary ? `$${installSummary.cost_usd}` : unknown}
      note={costNote(installSummary)}
      rows={[
        {
          label: t("home.glance.sessions"),
          value: installSummary
            ? number.format(installSummary.session_count)
            : unknown,
        },
        {
          label: t("home.glance.slots"),
          value: limits.data
            ? t("home.glance.slotsValue", {
                used: limits.data.usage.execution_slots_used,
                limit: limits.data.limits.execution_slot_limit,
              })
            : t("home.overview.unknown"),
        },
        { label: t("home.glance.outputs"), value: unmeasured },
      ]}
      footer={
        installSummary
          ? t("home.glance.refreshed", {
              at: formatTimestamp(installSummary.refreshed_at, locale),
            })
          : null
      }
    />
  ) : null;
  const oversightCard = (
    <GlanceCard
      key="oversight"
      eyebrow={t("home.glance.workspace")}
      title={t("home.glance.workspaceTitle")}
      badge={<Badge>{t("home.glance.operations")}</Badge>}
      value={attention === null ? t("home.overview.unknown") : attention}
      note={t("home.glance.attentionNote")}
      rows={[
        {
          label: t("home.glance.staleWait"),
          dot: requests && requests.stale > 0 ? "wait" : undefined,
          value: requests
            ? t("home.glance.sessionCount", { count: requests.stale })
            : t("home.overview.unknown"),
        },
        ...(oldest
          ? [
              {
                label: t("home.overview.oldest"),
                value: (
                  <>
                    <TextLink asChild className="font-mono font-normal">
                      <Link
                        to="/sessions/$id"
                        params={{ id: oldest.sessionId }}
                        title={oldest.sessionId}
                      >
                        {oldest.sessionId.slice(0, 8)}
                      </Link>
                    </TextLink>
                    {" · "}
                    <RelativeTime value={oldest.at} locale={locale} now={now} />
                  </>
                ),
              },
            ]
          : []),
        ...expiring.map((key) => ({
          wraps: true,
          label: (
            <KeyName
              apiKey={key}
              agentName={
                agentItems.find((agent) => agent.id === key.agent_id)?.name
              }
            />
          ),
          dot: "wait" as const,
          value: t("home.glance.keyExpires", {
            when: relativeTime(key.expires_at ?? "", locale, now),
          }),
        })),
        {
          label: t("home.overview.agents"),
          value: isApiError(agents.error, "FORBIDDEN")
            ? t("home.overview.agentsWithheld")
            : agents.data
              ? t("home.overview.agentsNote", {
                  active: activeAgents,
                  draft: draftAgents,
                })
              : t("home.overview.unknown"),
        },
      ]}
      footer={t("home.glance.attentionFooter")}
      link={<ArrowLink to="/sessions">{t("home.glance.toWaiting")}</ArrowLink>}
    />
  );
  const mineCard = (
    <GlanceCard
      key="mine"
      eyebrow={t("home.glance.mine")}
      title={t("home.glance.mineTitle")}
      value={mySummary ? `$${mySummary.cost_usd}` : unknown}
      note={costNote(mySummary)}
      rows={[
        {
          label: t("home.glance.sessions"),
          value: mySummary ? number.format(mySummary.session_count) : unknown,
        },
        {
          label: t("home.glance.runTime"),
          value: mySummary ? duration(mySummary.run_seconds, t) : unknown,
        },
        {
          label: t("home.glance.tokens"),
          value: mySummary ? number.format(mySummary.token_count) : unknown,
        },
      ]}
      footer={
        mySummary
          ? t("home.glance.refreshed", {
              at: formatTimestamp(mySummary.refreshed_at, locale),
            })
          : null
      }
    />
  );
  // A failed refetch keeps the old page; added to fresh ones it would count a
  // session that moved twice or not at all, so a failed list counts as unknown.
  const [waitingNow, runningNow, idleNow] = [waiting, running, idle].map(
    (query) => (query.isError ? undefined : query.data),
  );
  const openCount =
    waitingNow && runningNow && idleNow
      ? count(
          waitingNow.items.length +
            runningNow.items.length +
            idleNow.items.length,
          [waitingNow, runningNow, idleNow].some(
            (page) => page.next_cursor !== null,
          ),
        )
      : null;
  const progressCard = (
    <GlanceCard
      key="progress"
      eyebrow={t("home.glance.progress")}
      title={t("home.glance.progressTitle")}
      badge={<Badge>{t("home.glance.now")}</Badge>}
      value={openCount ?? t("home.overview.unknown")}
      note={t("home.glance.openNote")}
      rows={[
        {
          label: t("home.overview.waiting"),
          dot: "wait",
          value: pageCount(waitingNow),
        },
        {
          label: t("home.glance.running"),
          dot: "run",
          value: pageCount(runningNow),
        },
        {
          label: t("home.glance.idle"),
          dot: "idle",
          value: pageCount(idleNow),
        },
      ]}
      footer={t("home.overview.sessionsNote")}
      link={<ArrowLink to="/sessions">{t("home.glance.toSessions")}</ArrowLink>}
    />
  );
  // Only an active account answers for the person (contracts: a stale one
  // is ignored until relinked), so only active counts as linked.
  const slack = accounts.data
    ? accounts.data.items.some((account) => account.status === "active")
      ? "active"
      : accounts.data.items.some((account) => account.status === "stale")
        ? "stale"
        : "none"
    : undefined;
  const slackLinked = slack === undefined ? undefined : slack === "active";
  const accountsCard = (
    <GlanceCard
      key="accounts"
      eyebrow={t("home.glance.accounts")}
      title={t("home.glance.accountsTitle")}
      badge={<Badge>{t("home.glance.myAccounts")}</Badge>}
      // GitHub and Google cannot be linked yet, so only Slack can count.
      value={
        slackLinked === undefined
          ? t("home.overview.unknown")
          : t("home.glance.ratio", { count: slackLinked ? 1 : 0, total: 3 })
      }
      note={t("home.glance.linkedNote")}
      rows={[
        { label: "GitHub", dot: "idle", value: t("linked.soon") },
        {
          label: "Slack",
          dot: slack && SLACK_DOT[slack],
          value: slack ? t(SLACK_LABEL[slack]) : t("home.overview.unknown"),
        },
        { label: "Google Workspace", dot: "idle", value: t("linked.soon") },
      ]}
      footer={t("home.glance.accountsFooter")}
      link={
        <ArrowLink to="/settings/linked-accounts">
          {t("home.glance.toAccounts")}
        </ArrowLink>
      }
    />
  );
  const agentCard = (agent: Agent) => {
    // Only a workspace manager may list agents; an agent's own admin gets
    // no summary and keeps "not measured". A failed refetch keeps its old
    // data, which must not pass for the current figures.
    const listed = managesAgents && !agents.isError ? agents.data : undefined;
    const summary = listed?.items.find((item) => item.id === agent.id)?.summary;
    return (
      <GlanceCard
        key={agent.id}
        eyebrow={t("home.glance.agent")}
        title={agent.name}
        badge={<AgentStateBadge agent={agent} />}
        value={summary ? number.format(summary.needs_input_count) : unmeasured}
        note={t("home.glance.agentWaitingNote")}
        rows={[
          {
            label: t("home.glance.running"),
            value: summary ? number.format(summary.running_count) : unmeasured,
          },
          { label: t("home.glance.recentSessions"), value: unmeasured },
          {
            label: t("home.glance.credentials"),
            value: summary ? (
              <CredentialNeed
                refs={summary.version.credential_refs}
                bound={summary.bound_credential_refs}
              />
            ) : (
              unmeasured
            ),
          },
        ]}
        link={
          <TextLink
            asChild
            className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-(color:--ap-color-link) text-control"
          >
            <Link to="/agents/$id" params={{ id: agent.id }}>
              {t("home.glance.toAgent")}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </TextLink>
        }
      />
    );
  };
  // Every reader leads with the member's three (Console.dc.html homeCards
  // requester), then the cards of their role; the waiting count shows once,
  // on the progress card.
  const glance = [mineCard, progressCard, accountsCard];
  const cards =
    reader === "owner"
      ? [...glance, installCard, oversightCard]
      : reader === "admin"
        ? [...glance, ...managed.slice(0, 1).map(agentCard), oversightCard]
        : reader === "manager"
          ? [...glance, ...managed.slice(0, 2).map(agentCard)]
          : reader === "requester"
            ? glance
            : null;

  return (
    <DetailLayout rail={rail.rail}>
      <Page
        title={t("nav.home")}
        description={
          intros.length > 0 ? (
            <span className="grid">
              {intros.map((key) => (
                <span
                  key={key}
                  className={
                    key === reader
                      ? "[grid-area:1/1]"
                      : "invisible [grid-area:1/1]"
                  }
                  aria-hidden={key === reader ? undefined : true}
                >
                  {t(INTRO[key], { name })}
                </span>
              ))}
            </span>
          ) : undefined
        }
      >
        {settled ? null : <HomeSkeleton />}
        {/* Mounted from the start, so each section's own read is the one
            already on its way rather than a second one asked when it shows. */}
        <div hidden={!settled} className="contents">
          {checklistShown ? <Checklist steps={steps} /> : null}
          <ApprovalInbox
            layout="summary"
            rail={rail}
            title={t("home.requests.title")}
            action={
              <ArrowLink to="/sessions" search={{ status: "needs_input" }}>
                {t("home.requests.all")}
              </ArrowLink>
            }
            empty={<NoRequests />}
            now={now}
            limit={HOME_REQUESTS_LIMIT}
            more={(count) => (
              <ArrowLink to="/sessions" search={{ status: "needs_input" }}>
                {t("home.requests.more", { count })}
              </ArrowLink>
            )}
            renderError={loadError}
            unavailable={unavailable}
            refusal={refusal}
          />
          <HomeSection
            title={t("home.overview.title")}
            action={
              cards ? (
                <p className="m-0 text-caption text-muted-foreground">
                  {t("home.overview.basis")}
                </p>
              ) : undefined
            }
          >
            {cards ? (
              <ul className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[720px]:grid-cols-3">
                {cards}
              </ul>
            ) : readerFailure ? (
              <LoadFailure
                error={readerFailure.error}
                onRetry={readerFailure.retry}
              />
            ) : (
              <StatusScreen kind="loading" />
            )}
          </HomeSection>
          <HomeSection
            title={t("home.recent.title")}
            action={
              <ArrowLink to="/sessions">{t("home.recent.all")}</ArrowLink>
            }
          >
            <RecentSessionTable waitingSince={requests?.since} now={now} />
          </HomeSection>
          <AdministeredAgents showEmpty={false} />
          <MyTeams showEmpty={false} />
        </div>
      </Page>
    </DetailLayout>
  );
}

type Reader = "owner" | "admin" | "manager" | "requester";

const INTRO = {
  owner: "home.intro.owner",
  admin: "home.intro.admin",
  manager: "home.intro.manager",
  requester: "home.intro.requester",
} as const satisfies Record<Reader, MessageKey>;

/**
 * The design writes home for four readers: the owner, an admin, a member who
 * manages an agent, and any other member, told apart by the role and the
 * agents the reader manages. Undecided until those agents are read, so the
 * page does not change under the reader.
 */
function useReader(): {
  readonly reader: Reader | undefined;
  readonly agents: readonly Agent[];
  /** The agents could not be read, so a member's cards are not known. */
  readonly failure: { error: unknown; retry: () => void } | undefined;
  /** The agents that tell the reader apart are still on their way. */
  readonly deciding: boolean;
} {
  const { client } = useAgentPlatform();
  const role = useRole();
  // Same query as the agents section below, so it is read once.
  const administered = useQuery({
    ...administeredAgentsQuery(client),
    enabled: role !== undefined && role !== "owner",
  });
  const agents = administered.data?.items ?? [];
  const failure = undefined;
  // A session without a role (an API key) never gets a reader; nothing is
  // on its way for it either.
  const deciding = administered.isLoading;
  if (role === "owner") return { reader: "owner", agents, failure, deciding };
  if (administered.isError)
    return {
      reader: undefined,
      agents,
      failure: {
        error: administered.error,
        retry: () => void administered.refetch(),
      },
      deciding,
    };
  if (role === undefined || !administered.isSuccess)
    return { reader: undefined, agents, failure, deciding };
  if (role === "admin") return { reader: "admin", agents, failure, deciding };
  return {
    reader: agents.length > 0 ? "manager" : "requester",
    agents,
    failure,
    deciding,
  };
}

// waitingSessionsQuery's pace (packages/core queries.ts).
const WAITING_REFETCH_MS = 30_000;

/** One status's first page, read once the reader's cards are known. */
export function statusPageQuery(
  client: ApiClient,
  status: "running" | "idle",
  enabled: boolean,
) {
  return {
    queryKey: [...queryKeys.sessions, "home", status],
    // In step with the waiting list, or the open total adds counts read at
    // different times and counts a session twice or not at all.
    refetchInterval: WAITING_REFETCH_MS,
    queryFn: () =>
      unwrap(
        client.GET("/v1/sessions", { params: { query: { status } } }),
      ) as Promise<ListSessionsResponse>,
    enabled,
    retry: false,
  };
}

function pageCount(page: ListSessionsResponse | undefined): string {
  return page ? count(page.items.length, page.next_cursor !== null) : "—";
}

/** A first page that has more reads as "at least". */
/** The UTC day 30 days back: one query key a whole day, not each render. */
function last30Days(now: number): string {
  const day = new Date(now);
  day.setUTCDate(day.getUTCDate() - 30);
  return day.toISOString().slice(0, 10);
}

function count(items: number, more: boolean) {
  return more ? `${items}+` : String(items);
}

const RELATIVE_UNITS = [
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
] as const;

/** "3 days ago", "in 2 hours"; under a minute reads as now. */
export function relativeTime(
  iso: string,
  locale: Locale,
  now: number = Date.now(),
): string {
  const delta = new Date(iso).getTime() - now;
  if (Number.isNaN(delta)) return iso;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of RELATIVE_UNITS)
    if (Math.abs(delta) >= ms)
      return format.format(Math.trunc(delta / ms), unit);
  return format.format(0, "second");
}

/** How long since `iso`, in its largest whole unit: "12분", "2 hr". */
export function waitedFor(
  iso: string,
  locale: Locale,
  now: number = Date.now(),
): string {
  const elapsed = Math.max(0, now - new Date(iso).getTime());
  if (Number.isNaN(elapsed)) return iso;
  const [unit, ms] = RELATIVE_UNITS.find(([, size]) => elapsed >= size) ?? [
    "minute",
    60 * 1000,
  ];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
  }).format(Math.trunc(elapsed / ms));
}

function HomeSection({
  title,
  action,
  children,
}: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className="@container flex min-w-0 flex-col gap-[var(--ap-space-block)]"
      aria-labelledby={titleId}
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 id={titleId} className="m-0 font-semibold text-body">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function ArrowLink({
  to,
  search,
  children,
}: {
  readonly to: "/sessions" | "/settings/linked-accounts";
  readonly search?: { readonly status: "needs_input" };
  readonly children: ReactNode;
}) {
  return (
    <TextLink
      asChild
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-(color:--ap-color-link) text-control"
    >
      <Link to={to} {...(search ? { search } : {})}>
        {children}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </TextLink>
  );
}

/**
 * Stands in for the whole body while it is read: the inbox, the overview
 * cards and the recent sessions, roughly at their usual heights.
 */
function HomeSkeleton() {
  const { t } = useI18n();
  return (
    <div className="@container flex flex-col gap-[var(--ap-space-section)]">
      <Skeleton
        shape="block"
        height="10rem"
        label={t("status.loading.title")}
      />
      <div
        aria-hidden="true"
        className="grid grid-cols-1 gap-4 @[720px]:grid-cols-3"
      >
        <Skeleton shape="block" height="17rem" />
        <Skeleton shape="block" height="17rem" />
        <Skeleton shape="block" height="17rem" />
      </div>
      <div aria-hidden="true">
        <Skeleton shape="block" height="12rem" />
      </div>
    </div>
  );
}

/** The design's empty inbox: what will show up here, and when. */
function NoRequests() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border bg-card px-4 py-6 text-center text-control text-muted-foreground">
      <span className="mb-1 grid size-10 place-items-center rounded-[8px] border bg-(--ap-color-surface-sunken) text-subtle-foreground">
        <Inbox className="size-4" strokeWidth={1.5} aria-hidden="true" />
      </span>
      <p className="m-0 font-semibold text-body text-foreground">
        {t("home.requests.empty")}
      </p>
      <p className="m-0">{t("home.requests.emptyHint")}</p>
    </div>
  );
}

/** No API serves this figure yet; never a made-up number. */
function Unmeasured() {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true">{t("home.overview.unknown")}</span>
      <Badge>{t("home.glance.unmeasured")}</Badge>
    </span>
  );
}

/** A key goes by its name; one without goes by its agent, or else its kind. */
function KeyName({
  apiKey,
  agentName,
}: {
  readonly apiKey: ApiKeyView;
  readonly agentName: string | undefined;
}) {
  const { t } = useI18n();
  const label =
    apiKey.name ??
    (apiKey.kind === "agent"
      ? (agentName ?? t("apiKeys.kind.agent"))
      : t("apiKeys.kind.personal"));
  return (
    <TextLink asChild>
      <Link
        to={
          apiKey.kind === "personal"
            ? "/settings/api-keys"
            : "/settings/api-keys/agents"
        }
      >
        {label}
      </Link>
    </TextLink>
  );
}

interface GlanceRow {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** A label from data (an agent's name) wraps; fixed labels stay on one line. */
  readonly wraps?: boolean;
  readonly dot?: StatusDotStatus | undefined;
}

const SLACK_DOT = { active: "done", stale: "wait", none: "idle" } as const;
const SLACK_LABEL = {
  active: "linked.connected",
  stale: "home.glance.relink",
  none: "linked.notLinked",
} as const satisfies Record<keyof typeof SLACK_DOT, MessageKey>;

const SESSION_DOT = {
  queued: "idle",
  running: "run",
  needs_input: "wait",
  idle: "idle",
  failed: "failed",
  stopped: "idle",
} as const satisfies Record<SessionSummary["status"], StatusDotStatus>;

function GlanceCard({
  eyebrow,
  title,
  badge,
  value,
  note,
  rows,
  footer,
  link,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly badge?: ReactNode;
  readonly value: ReactNode;
  readonly note: string;
  readonly rows: readonly GlanceRow[];
  readonly footer?: ReactNode;
  readonly link?: ReactNode;
}) {
  // Every card reads the same way: what it covers, the headline figure and
  // what it is, the figures behind it, then where the numbers come from.
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 text-caption text-muted-foreground">{eyebrow}</p>
            <h3 className="m-0 font-semibold text-body">{title}</h3>
          </div>
          {badge ? <div className="shrink-0">{badge}</div> : null}
        </div>
        <div>
          <p className="m-0 font-semibold text-number tabular-nums">{value}</p>
          <p className="m-0 text-caption text-muted-foreground">{note}</p>
        </div>
        <dl className="m-0 flex flex-1 flex-col gap-1">
          {rows.map((row, index) => (
            <div
              // Rows are fixed per card apart from the keys, which come last
              // but one and keep their order.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className="flex min-h-6 min-w-0 items-center justify-between gap-3 text-control"
            >
              <dt
                className={cn(
                  "text-muted-foreground",
                  row.wraps
                    ? "min-w-0 [overflow-wrap:anywhere]"
                    : "shrink-0 whitespace-nowrap",
                )}
              >
                {row.label}
              </dt>
              <dd
                className={cn(
                  "m-0 inline-flex min-w-0 items-center justify-end gap-2 text-right tabular-nums",
                  row.wraps && "shrink-0",
                )}
              >
                {row.dot ? <StatusDot status={row.dot} /> : null}
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        {footer || link ? (
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <p
              className="m-0 min-w-0 truncate text-caption text-muted-foreground"
              title={typeof footer === "string" ? footer : undefined}
            >
              {footer}
            </p>
            {link}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

/** The newest of the viewer's sessions, in the design's columns. */
function RecentSessionTable({
  waitingSince,
  now,
}: {
  /** When each waiting session's oldest request came in, once every list is read. */
  readonly waitingSince: Readonly<Record<string, string>> | undefined;
  readonly now: number;
}) {
  const { t, locale } = useI18n();
  const sessions = useSessions();
  const items = sessions.data?.pages[0]?.items ?? [];

  if (sessions.isPending) return <StatusScreen kind="loading" />;
  if (sessions.error)
    return (
      <LoadFailure
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
      />
    );
  if (items.length === 0)
    return (
      // Framed as the table it stands in for, inside its padding.
      <p className="m-0 rounded-card border bg-card px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)] text-body text-muted-foreground">
        {t("sessions.empty")}
      </p>
    );
  // The row opener's focus ring sits outside the row: no overflow clipping.
  return (
    <div className="rounded-card border bg-card">
      <GridTable
        aria-label={t("home.recent.title")}
        columns={RECENT_COLUMNS}
        narrowAt={820}
        narrowColumns={RECENT_NARROW_COLUMNS}
      >
        <GridTableHeader>
          <GridTableColumnHeader>
            {t("sessions.column.id")}
          </GridTableColumnHeader>
          <GridTableColumnHeader>
            {t("sessions.column.status")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            {t("home.recent.agent")}
          </GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            {t("home.recent.repository")}
          </GridTableColumnHeader>
          <GridTableColumnHeader align="end" className="text-right">
            {t("home.recent.activity")}
          </GridTableColumnHeader>
        </GridTableHeader>
        {items.slice(0, RECENT_LIMIT).map((session) => (
          <RecentRow
            key={session.id}
            session={session}
            locale={locale}
            waitingSince={waitingSince?.[session.id]}
            now={now}
          />
        ))}
      </GridTable>
    </div>
  );
}

function RecentRow({
  session,
  locale,
  waitingSince,
  now,
}: {
  readonly session: SessionSummary;
  readonly locale: Locale;
  readonly waitingSince: string | undefined;
  readonly now: number;
}) {
  const { t } = useI18n();
  const at = session.last_event_at ?? session.created_at;
  return (
    <GridTableRow data-status={session.status}>
      <GridTableCell lines={true}>
        <GridTableRowOpener
          asChild
          aria-label={t("home.recent.open", {
            title: session.title ?? session.id.slice(0, 8),
          })}
        >
          <Link to="/sessions/$id" params={{ id: session.id }} />
        </GridTableRowOpener>
        {session.title ? (
          <>
            <span
              className="max-w-full truncate font-medium text-link"
              title={session.title}
            >
              {session.title}
            </span>
            <span
              className="font-mono text-caption text-muted-foreground"
              title={session.id}
            >
              {session.id.slice(0, 8)}
            </span>
          </>
        ) : (
          <span className="font-mono font-medium text-link" title={session.id}>
            {session.id.slice(0, 8)}
          </span>
        )}
      </GridTableCell>
      {/* Raised: the wait's exact time opens on its own hover and focus. */}
      <GridTableCell raised={true}>
        <div
          className="flex min-w-0 items-center gap-2 text-control"
          data-state={session.status}
        >
          <StatusDot status={SESSION_DOT[session.status]} />
          <span>
            <span className="sr-only">{t("home.recent.statusAxis")} </span>
            {t(`sessions.status.${session.status}`)}
            {session.status === "needs_input" && waitingSince ? (
              <>
                {" · "}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <time
                      dateTime={waitingSince}
                      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users reach the exact time only through focus
                      tabIndex={0}
                      className="rounded-sm focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2"
                    >
                      {waitedFor(waitingSince, locale, now)}
                    </time>
                  </TooltipTrigger>
                  <TooltipContent>
                    {formatExactTime(waitingSince, locale)}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
          </span>
        </div>
      </GridTableCell>
      {/* Sessions do not name their agent yet. */}
      <GridTableCell hideNarrow={true} className="text-muted-foreground">
        {t("home.overview.unknown")}
      </GridTableCell>
      <GridTableCell hideNarrow={true}>
        <span className="flex min-w-0 items-center gap-2">
          {session.repository_id ? (
            <>
              <GitBranch
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span
                className="truncate font-mono text-caption"
                title={session.repository_id}
              >
                {session.repository_id}
              </span>
            </>
          ) : (
            <>
              <Folder
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate text-caption text-muted-foreground">
                {t("home.recent.noRepository")}
              </span>
            </>
          )}
        </span>
      </GridTableCell>
      {/* Raised for the exact time's tooltip, as the status cell. */}
      <GridTableCell
        align="end"
        raised={true}
        className="text-right text-muted-foreground"
      >
        <RelativeTime value={at} locale={locale} now={now} />
      </GridTableCell>
    </GridTableRow>
  );
}

function Checklist({ steps }: { readonly steps: readonly Step[] }) {
  const { t } = useI18n();
  const titleId = useId();
  const done = steps.filter((step) => step.state === "done").length;
  const next = steps.find((step) => step.state !== "done");
  return (
    <section
      className="flex min-w-0 flex-col gap-[var(--ap-space-block)]"
      aria-labelledby={titleId}
      data-slot="home-checklist"
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 id={titleId} className="m-0 font-semibold text-body">
          {t("home.checklist.title")}
        </h2>
        <span className="text-caption text-muted-foreground">
          {t("home.checklist.progress", { done, total: steps.length })}
        </span>
      </div>
      <Card className="p-4">
        <Steps
          completedLabel={t("common.done")}
          items={steps.map((step) => ({
            id: step.key,
            title: t(step.key),
            // Steps marks done or not; an unreadable step says so in words.
            description:
              step.state === "unknown" ? (
                <>
                  {t(step.hint)}
                  {" · "}
                  <span>{t("home.checklist.unknown")}</span>
                </>
              ) : (
                t(step.hint)
              ),
            done: step.state === "done",
            action: step.to ? (
              <Button
                asChild
                size="sm"
                variant={step === next ? "default" : "outline"}
                className="shrink-0"
              >
                <Link to={step.to}>{t(STEP_ACTION[step.to])}</Link>
              </Button>
            ) : undefined,
          }))}
        />
      </Card>
    </section>
  );
}

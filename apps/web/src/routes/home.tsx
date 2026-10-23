import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ApiClient, isApiError, unwrap } from "@werft-ai/client";
import type {
  Agent,
  ApiKeyView,
  InstallationLimitsResponse,
  ListSessionsResponse,
  SessionSummary,
} from "@werft-ai/contracts";
import {
  apiKeysQuery,
  pendingRequestsQuery,
  queryKeys,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { useAgentPlatform, useSessions } from "@werft-ai/react";
import { ApprovalInbox } from "@werft-ai/react/blocks";
import {
  Badge,
  Card,
  cn,
  formatTimestamp,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Link as TextLink,
} from "@werft-ai/ui";
import { ArrowRight, Check, Folder, GitBranch } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import {
  administeredAgentsQuery,
  agentsQuery,
  invitesQuery,
  linkedAccountsQuery,
  membersQuery,
} from "../api/queries.ts";
import { useMe, useRole } from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { AgentStateBadge } from "../components/agent-state.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import {
  errorKey,
  type Locale,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";
import { agentState } from "./agents.tsx";
import { expiryState } from "./api-keys.tsx";
import { loadError, NewSessionButton, useUnavailable } from "./sessions.tsx";

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

const STATE_KEY = {
  done: "common.done",
  pending: "common.pending",
  unknown: "home.checklist.unknown",
} as const satisfies Record<StepState, MessageKey>;

const RECENT_LIMIT = 5;
const STALE_WAIT_MS = 30 * 60 * 1000;
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
 * The requests waiting on the viewer, answerable in place, then counts with
 * the session that waited longest, the newest sessions and the bootstrap
 * checklist. Each checklist step is read from the server: someone
 * was invited once an invite exists or a second member joined, an agent is
 * ready once one has an active release, and a session started once the
 * viewer's own session list has one.
 *
 * The overview cards follow the design canvas. A figure no API serves yet
 * (spend, run time, tokens, linked-account expiry) reads "not measured"
 * instead of a number.
 */
export function HomeScreen() {
  const { t, locale } = useI18n();
  const { reader, agents: managed, failure: readerFailure } = useReader();
  const name = useMe()?.user?.display_name;
  const intro =
    reader === "owner" || reader === "admin"
      ? t(INTRO[reader])
      : reader && name
        ? t(INTRO[reader], { name })
        : undefined;
  const now = useNow();
  const unavailable = useUnavailable();
  const { client } = useAgentPlatform();
  const members = useQuery({
    ...membersQuery(client),
    select: (page) => page.items.length > 1,
  });
  const invites = useQuery({
    ...invitesQuery(client),
    select: (page) => page.items.length > 0,
  });
  const agents = useQuery(agentsQuery(client));
  const sessions = useSessions();
  const waiting = useQuery(waitingSessionsQuery(client));
  const limits = useQuery({
    queryKey: ["limits"],
    queryFn: () =>
      unwrap(client.GET("/v1/limits")) as Promise<InstallationLimitsResponse>,
    retry: false,
  });
  const keys = useQuery(apiKeysQuery(client));
  const requester = reader === "requester";
  const running = useQuery(statusPageQuery(client, "running", requester));
  const idle = useQuery(statusPageQuery(client, "idle", requester));
  const accounts = useQuery({
    ...linkedAccountsQuery(client),
    enabled: requester,
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
  const allDone = steps.every((step) => step.state === "done");
  const checklist = <Checklist steps={steps} />;

  const waitingCount = waiting.data
    ? count(waiting.data.items.length, waiting.data.next_cursor !== null)
    : null;
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
  // The design shows the installation's figures to its owner only; a viewer
  // the server refuses does not get the card either.
  const installCard = isApiError(limits.error, "FORBIDDEN") ? null : (
    <GlanceCard
      key="install"
      eyebrow={t("home.glance.installation")}
      title={t("home.glance.installationTitle")}
      value={unmeasured}
      note={t("home.glance.estimatedCost")}
      rows={[
        { label: t("home.glance.sessions"), value: unmeasured },
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
        limits.data
          ? t("home.glance.refreshed", {
              at: formatTimestamp(limits.data.refreshed_at, locale),
            })
          : null
      }
    />
  );
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
          label: t("home.overview.waiting"),
          value: waitingCount ?? t("home.overview.unknown"),
        },
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
                    <time
                      dateTime={oldest.at}
                      title={formatTimestamp(oldest.at, locale)}
                    >
                      {relativeTime(oldest.at, locale, now)}
                    </time>
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
        { label: t("home.glance.linkedExpiry"), value: unmeasured },
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
      value={unmeasured}
      note={t("home.glance.estimatedCost")}
      rows={[
        // No list says who started a session yet, so even the count waits.
        { label: t("home.glance.sessions"), value: unmeasured },
        { label: t("home.glance.runTime"), value: unmeasured },
        { label: t("home.glance.tokens"), value: unmeasured },
      ]}
    />
  );
  const openCount =
    waiting.data && running.data && idle.data
      ? count(
          waiting.data.items.length +
            running.data.items.length +
            idle.data.items.length,
          [waiting.data, running.data, idle.data].some(
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
          value: waitingCount ?? t("home.overview.unknown"),
        },
        {
          label: t("home.glance.running"),
          dot: "run",
          value: pageCount(running.data),
        },
        {
          label: t("home.glance.idle"),
          dot: "idle",
          value: pageCount(idle.data),
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
  const agentCard = (agent: Agent) => (
    <GlanceCard
      key={agent.id}
      eyebrow={t("home.glance.agent")}
      title={agent.name}
      badge={<AgentStateBadge agent={agent} />}
      value={unmeasured}
      note={t("home.glance.agentWaitingNote")}
      rows={[
        { label: t("home.glance.running"), value: unmeasured },
        { label: t("home.glance.recentSessions"), value: unmeasured },
        { label: t("home.glance.credentials"), value: unmeasured },
      ]}
      link={
        <TextLink
          asChild
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-control"
        >
          <Link to="/agents/$id" params={{ id: agent.id }}>
            {t("home.glance.toAgent")}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </TextLink>
      }
    />
  );
  // The design's card set for each reader (Console.dc.html homeCards).
  const cards =
    reader === "owner"
      ? [installCard, oversightCard, mineCard]
      : reader === "admin"
        ? [mineCard, ...managed.slice(0, 1).map(agentCard), oversightCard]
        : reader === "manager"
          ? [mineCard, ...managed.slice(0, 2).map(agentCard)]
          : reader === "requester"
            ? [mineCard, progressCard, accountsCard]
            : null;

  return (
    <Page
      title={t("nav.home")}
      description={intro}
      actions={<NewSessionButton />}
    >
      {allDone ? null : checklist}
      <ApprovalInbox
        layout="row"
        loading={<StatusScreen kind="loading" />}
        renderError={loadError}
        unavailable={unavailable}
        refusal={(error) => t(errorKey(error.code))}
      />
      <HomeSection
        title={t("home.overview.title")}
        action={
          // The design's "last 30 days" basis waits for a usage period (94S-814).
          reader === "owner" ? (
            <p className="m-0 text-caption text-muted-foreground">
              {t("home.overview.ownerBasis")}
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
        action={<ArrowLink to="/sessions">{t("home.recent.all")}</ArrowLink>}
      >
        <RecentSessionTable waitingSince={requests?.since} now={now} />
      </HomeSection>
      {allDone ? checklist : null}
      <AdministeredAgents showEmpty={false} />
      <MyTeams showEmpty={false} />
    </Page>
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
  if (role === "owner") return { reader: "owner", agents, failure };
  if (administered.isError)
    return {
      reader: undefined,
      agents,
      failure: {
        error: administered.error,
        retry: () => void administered.refetch(),
      },
    };
  if (role === undefined || !administered.isSuccess)
    return { reader: undefined, agents, failure };
  if (role === "admin") return { reader: "admin", agents, failure };
  return {
    reader: agents.length > 0 ? "manager" : "requester",
    agents,
    failure,
  };
}

// waitingSessionsQuery's pace (packages/core queries.ts).
const WAITING_REFETCH_MS = 30_000;

/** One status's first page, read only for the reader whose card counts it. */
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
  children,
}: {
  readonly to: "/sessions" | "/settings/linked-accounts";
  readonly children: ReactNode;
}) {
  return (
    <TextLink
      asChild
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-control"
    >
      <Link to={to}>
        {children}
        <ArrowRight className="size-3.5" aria-hidden="true" />
      </Link>
    </TextLink>
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

/** Keys carry no name: an agent's key goes by its agent, others by kind. */
function KeyName({
  apiKey,
  agentName,
}: {
  readonly apiKey: ApiKeyView;
  readonly agentName: string | undefined;
}) {
  const { t } = useI18n();
  const label =
    apiKey.agent_id !== null
      ? (agentName ?? t("apiKeys.kind.agent"))
      : t(
          apiKey.kind === "personal"
            ? "apiKeys.kind.personal"
            : "apiKeys.kind.service",
        );
  return (
    <TextLink asChild>
      <Link
        to={
          apiKey.kind === "personal"
            ? "/settings/api-keys"
            : "/settings/api-keys/service"
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
  readonly dot?: Dot | undefined;
}

type Dot = "wait" | "run" | "idle" | "done" | "failed";

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
} as const satisfies Record<SessionSummary["status"], Dot>;

// Console.dc.html .dot: 8px, the running one a 10px ring turning every 0.9s.
const DOT_CLASS = {
  wait: "size-2 bg-(--ap-color-status-dot-wait)",
  done: "size-2 bg-(--ap-color-status-dot-done)",
  failed: "size-2 bg-(--ap-color-status-dot-failed)",
  idle: "size-2 bg-(--ap-color-status-dot-idle)",
  run: "size-2.5 animate-spin border-[1.5px] border-(--ap-color-status-dot-run) border-r-transparent [animation-duration:0.9s] motion-reduce:size-2 motion-reduce:animate-none motion-reduce:border-r-(--ap-color-status-dot-run) motion-reduce:bg-(--ap-color-status-dot-run)",
} as const satisfies Record<Dot, string>;

/** The design's status dot; the text beside it carries the meaning. */
function StatusDot({ dot }: { readonly dot: Dot }) {
  return (
    <span
      className={cn("shrink-0 rounded-full", DOT_CLASS[dot])}
      data-dot={dot}
      aria-hidden="true"
    />
  );
}

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
                {row.dot ? <StatusDot dot={row.dot} /> : null}
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
      <p className="m-0 text-body text-muted-foreground">
        {t("sessions.empty")}
      </p>
    );
  return (
    <TableContainer label={t("home.recent.title")}>
      <Table aria-label={t("home.recent.title")}>
        <TableHeader>
          <TableRow>
            <TableHead>{t("sessions.column.id")}</TableHead>
            <TableHead>{t("sessions.column.status")}</TableHead>
            <TableHead>{t("home.recent.agent")}</TableHead>
            <TableHead>{t("home.recent.repository")}</TableHead>
            <TableHead className="whitespace-nowrap text-right">
              {t("home.recent.activity")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.slice(0, RECENT_LIMIT).map((session) => (
            <RecentRow
              key={session.id}
              session={session}
              locale={locale}
              waitingSince={waitingSince?.[session.id]}
              now={now}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
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
    <TableRow data-status={session.status}>
      <TableCell>
        {session.title ? (
          <div className="flex max-w-80 flex-col">
            <TextLink asChild className="truncate">
              <Link
                to="/sessions/$id"
                params={{ id: session.id }}
                title={session.title}
              >
                {session.title}
              </Link>
            </TextLink>
            <span
              className="font-mono text-caption text-muted-foreground"
              title={session.id}
            >
              {session.id.slice(0, 8)}
            </span>
          </div>
        ) : (
          <TextLink asChild className="font-mono">
            <Link
              to="/sessions/$id"
              params={{ id: session.id }}
              aria-label={session.id}
              title={session.id}
            >
              {session.id.slice(0, 8)}
            </Link>
          </TextLink>
        )}
      </TableCell>
      <TableCell>
        <div
          className="flex items-center gap-2 whitespace-nowrap text-control"
          data-state={session.status}
        >
          <StatusDot dot={SESSION_DOT[session.status]} />
          <span>
            <span className="sr-only">{t("home.recent.statusAxis")} </span>
            {t(`sessions.status.${session.status}`)}
            {session.status === "needs_input" && waitingSince ? (
              <>
                {" · "}
                <time
                  dateTime={waitingSince}
                  title={formatTimestamp(waitingSince, locale)}
                >
                  {waitedFor(waitingSince, locale, now)}
                </time>
              </>
            ) : null}
          </span>
        </div>
      </TableCell>
      {/* Sessions do not name their agent yet. */}
      <TableCell className="text-muted-foreground">
        {t("home.overview.unknown")}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          {session.repository_id ? (
            <>
              <GitBranch
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="font-mono text-caption">
                {session.repository_id}
              </span>
            </>
          ) : (
            <>
              <Folder
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="text-caption text-muted-foreground">
                {t("home.recent.noRepository")}
              </span>
            </>
          )}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap text-right text-muted-foreground">
        <time dateTime={at} title={formatTimestamp(at, locale)}>
          {relativeTime(at, locale, now)}
        </time>
      </TableCell>
    </TableRow>
  );
}

function Checklist({ steps }: { readonly steps: readonly Step[] }) {
  const { t } = useI18n();
  const titleId = useId();
  const done = steps.filter((step) => step.state === "done").length;
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
      <Card className="px-4 py-1">
        <ol className="m-0 flex list-none flex-col p-0">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className="flex min-h-16 items-center gap-3 border-t py-3 first:border-t-transparent"
              data-done={step.state === "done"}
              data-state={step.state}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full border border-border-strong font-semibold text-caption text-muted-foreground",
                  step.state === "done" &&
                    "border-primary bg-primary text-primary-foreground",
                )}
              >
                {step.state === "done" ? (
                  <Check className="size-3.5" strokeWidth={2} />
                ) : (
                  index + 1
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                {step.to ? (
                  <TextLink
                    asChild
                    underline="always"
                    className="font-medium text-control"
                  >
                    <Link to={step.to}>{t(step.key)}</Link>
                  </TextLink>
                ) : (
                  <span className="font-medium text-control">
                    {t(step.key)}
                  </span>
                )}
                <span className="text-caption text-muted-foreground">
                  {t(step.hint)}
                </span>
              </span>
              <span className="shrink-0 text-caption text-muted-foreground">
                {t(STATE_KEY[step.state])}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

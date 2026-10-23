import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isApiError, unwrap } from "@werft-ai/client";
import type {
  ApiKeyView,
  InstallationLimitsResponse,
  SessionSummary,
} from "@werft-ai/contracts";
import {
  apiKeysQuery,
  pendingRequestsQuery,
  waitingSessionsQuery,
} from "@werft-ai/core";
import { useAgentPlatform, useSessions } from "@werft-ai/react";
import { SessionStatusLabel } from "@werft-ai/react/components";
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
import { ArrowRight, Check } from "lucide-react";
import { type ReactNode, useId } from "react";
import { agentsQuery, invitesQuery, membersQuery } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { type Locale, type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { agentState } from "./agents.tsx";
import { expiryState } from "./api-keys.tsx";

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

/**
 * Counts with the session that waited longest, the newest sessions and the
 * bootstrap checklist; answering a request is the session screen's job. Each checklist step is read from the server: someone
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
  const me = useMe();
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
  // Answering happens on the session screen; home names only the oldest
  // request, read from the same per-session lists the session screen reads.
  // It shows nothing unless the one page holds every waiting session and
  // every list answered: a partial read would name the wrong request. A failed
  // refetch keeps the old page in data, so the last read must have succeeded.
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
      const staleBefore = new Date(Date.now() - STALE_WAIT_MS).toISOString();
      lists.forEach((list, index) => {
        const sessionId = waiting.data?.items[index]?.id;
        let sessionFirst: string | undefined;
        for (const request of list.data?.items ?? []) {
          if (!sessionFirst || request.created_at < sessionFirst)
            sessionFirst = request.created_at;
          if (sessionId && (!first || request.created_at < first.at))
            first = { sessionId, at: request.created_at };
        }
        if (sessionFirst && sessionFirst < staleBefore) stale += 1;
      });
      return { oldest: first, stale };
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

  return (
    <Page
      title={t("nav.home")}
      description={
        me?.user ? (
          <span className="[overflow-wrap:anywhere]">
            {t("home.signedInAs", {
              name: me.user.display_name,
              email: me.user.email,
            })}
          </span>
        ) : undefined
      }
    >
      {allDone ? null : checklist}
      <HomeSection title={t("home.overview.title")}>
        <ul className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[720px]:grid-cols-3">
          {/* Everyone who reads sessions may read the limits; the card
              stays away only for a viewer the server refuses. */}
          {isApiError(limits.error, "FORBIDDEN") ? null : (
            <GlanceCard
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
          )}
          <GlanceCard
            eyebrow={t("home.glance.workspace")}
            title={t("home.glance.workspaceTitle")}
            value={attention === null ? t("home.overview.unknown") : attention}
            note={t("home.glance.attentionNote")}
            rows={[
              {
                label: t("home.overview.waiting"),
                value: waitingCount ?? t("home.overview.unknown"),
              },
              {
                label: t("home.glance.staleWait"),
                value: requests ? (
                  <Caution on={requests.stale > 0}>
                    {t("home.glance.sessionCount", { count: requests.stale })}
                  </Caution>
                ) : (
                  t("home.overview.unknown")
                ),
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
                            {relativeTime(oldest.at, locale)}
                          </time>
                        </>
                      ),
                    },
                  ]
                : []),
              ...expiring.map((key) => ({
                label: (
                  <KeyName
                    apiKey={key}
                    agentName={
                      agentItems.find((agent) => agent.id === key.agent_id)
                        ?.name
                    }
                  />
                ),
                value: (
                  <Caution on>
                    {t("home.glance.keyExpires", {
                      when: relativeTime(key.expires_at ?? "", locale),
                    })}
                  </Caution>
                ),
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
            link={
              <ArrowLink to="/sessions">{t("home.glance.toWaiting")}</ArrowLink>
            }
          />
          <GlanceCard
            eyebrow={t("home.glance.mine")}
            title={t("home.glance.mineTitle")}
            value={unmeasured}
            note={t("home.glance.estimatedCost")}
            rows={[
              {
                label: t("home.glance.sessions"),
                value: firstPage
                  ? count(
                      firstPage.items.length,
                      firstPage.next_cursor !== null,
                    )
                  : t("home.overview.unknown"),
              },
              { label: t("home.glance.runTime"), value: unmeasured },
              { label: t("home.glance.tokens"), value: unmeasured },
            ]}
            footer={t("home.overview.sessionsNote")}
          />
        </ul>
      </HomeSection>
      <HomeSection
        title={t("home.recent.title")}
        action={<ArrowLink to="/sessions">{t("home.recent.all")}</ArrowLink>}
      >
        <RecentSessionTable />
      </HomeSection>
      {allDone ? checklist : null}
      <AdministeredAgents showEmpty={false} />
      <MyTeams showEmpty={false} />
    </Page>
  );
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
  readonly to: "/sessions";
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
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true">{t("home.overview.unknown")}</span>
      <Badge>{t("home.glance.unmeasured")}</Badge>
    </span>
  );
}

function Caution({
  on,
  children,
}: {
  readonly on: boolean;
  readonly children: ReactNode;
}) {
  return on ? <Badge variant="amber">{children}</Badge> : children;
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
}

function GlanceCard({
  eyebrow,
  title,
  value,
  note,
  rows,
  footer,
  link,
}: {
  readonly eyebrow: string;
  readonly title: string;
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
      <Card className="h-full gap-4 p-4">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-caption text-muted-foreground">{eyebrow}</p>
          <h3 className="m-0 font-semibold text-control">{title}</h3>
        </div>
        <div>
          <p className="m-0 font-semibold text-number tabular-nums">{value}</p>
          <p className="m-0 text-caption text-muted-foreground">{note}</p>
        </div>
        <dl className="m-0 flex flex-1 flex-col gap-2">
          {rows.map((row, index) => (
            <div
              // Rows are fixed per card apart from the keys, which come last
              // but one and keep their order.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className="flex min-w-0 items-center justify-between gap-3 text-control"
            >
              <dt className="min-w-0 text-muted-foreground">{row.label}</dt>
              <dd className="m-0 min-w-0 text-right tabular-nums">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        {footer || link ? (
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <p className="m-0 text-caption text-muted-foreground">{footer}</p>
            {link}
          </div>
        ) : null}
      </Card>
    </li>
  );
}

/** The newest of the viewer's sessions, in the design's columns. */
function RecentSessionTable() {
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
            <RecentRow key={session.id} session={session} locale={locale} />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function RecentRow({
  session,
  locale,
}: {
  readonly session: SessionSummary;
  readonly locale: Locale;
}) {
  const { t } = useI18n();
  const at = session.last_event_at ?? session.created_at;
  return (
    <TableRow data-status={session.status}>
      <TableCell>
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
      </TableCell>
      <TableCell>
        {/* flex, not a line box: an inline badge sits on the baseline and
            leaves the row's centers a pixel apart. */}
        <div className="flex">
          <SessionStatusLabel
            className="whitespace-nowrap"
            status={session.status}
            label={t(`sessions.status.${session.status}`)}
          />
        </div>
      </TableCell>
      {/* Sessions do not name their agent yet. */}
      <TableCell className="text-muted-foreground">
        {t("home.overview.unknown")}
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {session.repository_id ?? t("home.overview.unknown")}
      </TableCell>
      <TableCell className="whitespace-nowrap text-right text-muted-foreground">
        <time dateTime={at} title={formatTimestamp(at, locale)}>
          {relativeTime(at, locale)}
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

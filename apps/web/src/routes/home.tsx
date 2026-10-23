import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import type { SessionSummary } from "@werft-ai/contracts";
import { waitingSessionsQuery } from "@werft-ai/core";
import { useAgentPlatform, useSessions } from "@werft-ai/react";
import { RecentSessions } from "@werft-ai/react/blocks";
import { Card, cn, formatTimestamp } from "@werft-ai/ui";
import { ArrowRight, Check } from "lucide-react";
import { type ReactNode, useId } from "react";
import { agentsQuery, invitesQuery, membersQuery } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { Page } from "../components/page.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { agentState } from "./agents.tsx";

/** Done, not yet, or not knowable here (the list refused this viewer, or failed). */
type StepState = "done" | "pending" | "unknown";

interface Step {
  readonly key: MessageKey;
  readonly state: StepState;
  readonly to?: "/members" | "/agents" | "/sessions";
  readonly hint?: MessageKey;
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

const LINK =
  "inline-flex items-center gap-1 font-medium text-control text-primary underline-offset-2 hover:underline";
const RECENT_LIMIT = 5;

function loadError(error: unknown, onRetry: () => void) {
  return <LoadFailure error={error} onRetry={onRetry} />;
}

/**
 * Counts with the session that waited longest, the newest sessions and the
 * bootstrap checklist; answering a request is the session screen's job. Each checklist step is read from the server: someone
 * was invited once an invite exists or a second member joined, an agent is
 * ready once one has an active release, and a session started once the
 * viewer's own session list has one.
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
  // Either list can show the step done; to call it not done, both must answer.
  const invited: StepState =
    members.data || invites.data
      ? "done"
      : members.isError || invites.isError
        ? "unknown"
        : stateOf(members);
  const firstPage = sessions.data?.pages[0];
  const steps: readonly Step[] = [
    { key: "home.checklist.admin", state: "done" },
    { key: "home.checklist.invite", state: invited, to: "/members" },
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
  // Answering happens on the session screen; home names only who waited longest.
  const oldest = waiting.data?.items.reduce<SessionSummary | undefined>(
    (first, item) =>
      first === undefined || item.updated_at < first.updated_at ? item : first,
    undefined,
  );
  const agentItems = agents.data?.items ?? [];
  const activeAgents = agentItems.filter(
    (agent) => agentState(agent) === "active",
  ).length;
  const draftAgents = agentItems.filter(
    (agent) => agentState(agent) === "draft",
  ).length;

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
        <ul className="m-0 grid list-none grid-cols-1 items-stretch gap-4 p-0 @[640px]:grid-cols-3">
          <SummaryCard
            title={t("home.overview.waiting")}
            value={waitingCount}
            note={t("home.overview.waitingNote")}
            detail={
              oldest ? (
                <>
                  {t("home.overview.oldest")}{" "}
                  <Link
                    to="/sessions/$id"
                    params={{ id: oldest.id }}
                    className="font-mono text-primary underline-offset-2 hover:underline"
                    title={oldest.id}
                  >
                    {oldest.id.slice(0, 8)}
                  </Link>
                  {" · "}
                  {formatTimestamp(oldest.updated_at, locale)}
                </>
              ) : null
            }
            link={
              <Link to="/sessions" className={LINK}>
                {t("home.overview.toSessions")}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            }
          />
          <SummaryCard
            title={t("home.overview.sessions")}
            value={
              firstPage
                ? count(firstPage.items.length, firstPage.next_cursor !== null)
                : null
            }
            note={t("home.overview.sessionsNote")}
            link={
              <Link to="/sessions" className={LINK}>
                {t("home.overview.toSessions")}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            }
          />
          <SummaryCard
            title={t("home.overview.agents")}
            value={agents.data ? String(agentItems.length) : null}
            note={
              isApiError(agents.error, "FORBIDDEN")
                ? t("home.overview.agentsWithheld")
                : t("home.overview.agentsNote", {
                    active: activeAgents,
                    draft: draftAgents,
                  })
            }
            link={
              <Link to="/agents" className={LINK}>
                {t("home.overview.toAgents")}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            }
          />
        </ul>
      </HomeSection>
      <HomeSection title={t("home.recent.title")}>
        <RecentSessions
          label={t("home.recent.title")}
          limit={RECENT_LIMIT}
          loading={<StatusScreen kind="loading" />}
          renderError={loadError}
        />
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

function HomeSection({
  title,
  children,
}: {
  readonly title: string;
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
      </div>
      {children}
    </section>
  );
}

function SummaryCard({
  title,
  value,
  note,
  detail,
  link,
}: {
  readonly title: string;
  /** null until the count is known. */
  readonly value: string | null;
  readonly note: string;
  readonly detail?: ReactNode;
  readonly link: ReactNode;
}) {
  const { t } = useI18n();
  // Every tile reads the same way: what it counts and where to go on one
  // line, then the number, then what the number is.
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 p-4">
        <div className="flex min-h-5 items-center justify-between gap-3">
          <h3 className="m-0 font-medium text-control text-muted-foreground">
            {title}
          </h3>
          {link}
        </div>
        <div>
          <p className="m-0 font-semibold text-number tabular-nums">
            {value ?? t("home.overview.unknown")}
          </p>
          <p className="m-0 text-caption text-muted-foreground">{note}</p>
        </div>
        {detail ? (
          <p className="m-0 truncate border-t pt-3 text-caption text-muted-foreground">
            {detail}
          </p>
        ) : null}
      </Card>
    </li>
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
      <Card className="p-4">
        <ol className="m-0 flex list-none flex-col p-0">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className="flex items-center gap-3 border-t py-3 first:border-t-0 first:pt-0 last:pb-0"
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
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                {step.to ? (
                  <Link
                    className="font-medium text-control text-primary underline underline-offset-2"
                    to={step.to}
                  >
                    {t(step.key)}
                  </Link>
                ) : (
                  <span className="font-medium text-control">
                    {t(step.key)}
                  </span>
                )}
                {step.hint ? (
                  <span className="text-caption text-muted-foreground">
                    {t(step.hint)}
                  </span>
                ) : null}
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

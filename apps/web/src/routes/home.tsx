import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useAgentPlatform, useSessions } from "@werft-ai/react";
import { Card, CardContent, CardHeader, CardTitle } from "@werft-ai/ui";
import { useId } from "react";
import { agentsQuery, invitesQuery, membersQuery } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { MyTeams } from "../components/my-teams.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";

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
const MARK = { done: "✓", pending: "○", unknown: "–" } as const;

/**
 * The bootstrap checklist, each step read from the server: someone was
 * invited once an invite exists or a second member joined, and an agent is
 * ready once one has an active release, and a session started once the
 * viewer's own session list has one.
 */
export function HomeScreen() {
  const { t } = useI18n();
  const me = useMe();
  const { client } = useAgentPlatform();
  const checklistTitle = useId();
  const members = useQuery({
    ...membersQuery(client),
    select: (page) => page.items.length > 1,
  });
  const invites = useQuery({
    ...invitesQuery(client),
    select: (page) => page.items.length > 0,
  });
  const agents = useQuery({
    ...agentsQuery(client),
    select: (page) =>
      page.items.some((agent) => agent.active_release_id !== null),
  });
  const sessions = useSessions();
  // Either list can show the step done; to call it not done, both must answer.
  const invited: StepState =
    members.data || invites.data
      ? "done"
      : members.isError || invites.isError
        ? "unknown"
        : stateOf(members);
  const steps: readonly Step[] = [
    { key: "home.checklist.admin", state: "done" },
    { key: "home.checklist.invite", state: invited, to: "/members" },
    { key: "home.checklist.agent", state: stateOf(agents), to: "/agents" },
    {
      key: "home.checklist.session",
      state: stateOf({
        isSuccess: sessions.isSuccess,
        isError: sessions.isError,
        data: (sessions.data?.pages[0]?.items.length ?? 0) > 0,
      }),
      to: "/sessions",
      hint: "home.checklist.sessionHint",
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 font-semibold text-xl">
          {me?.workspace?.name ?? t("home.title")}
        </h1>
        {me?.user ? (
          <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]">
            {t("home.signedInAs", {
              name: me.user.display_name,
              email: me.user.email,
            })}
          </p>
        ) : null}
      </div>
      <Card className="gap-4" aria-labelledby={checklistTitle} role="region">
        <CardHeader>
          <CardTitle>
            <h2 id={checklistTitle} className="m-0 text-lg">
              {t("home.checklist.title")}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {steps.map((step) => (
              <li
                key={step.key}
                className="flex items-start gap-3 rounded-md border p-3 data-[done=false]:text-muted-foreground"
                data-done={step.state === "done"}
                data-state={step.state}
              >
                <span aria-hidden="true">{MARK[step.state]}</span>
                <span className="flex min-w-0 flex-col gap-1">
                  {step.to ? (
                    <Link
                      className="text-primary underline underline-offset-2"
                      to={step.to}
                    >
                      {t(step.key)}
                    </Link>
                  ) : (
                    <span>{t(step.key)}</span>
                  )}
                  {step.hint ? (
                    <span className="text-muted-foreground text-sm">
                      {t(step.hint)}
                    </span>
                  ) : null}
                </span>
                <span className="ml-auto shrink-0 text-xs">
                  {t(STATE_KEY[step.state])}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
      <AdministeredAgents showEmpty={false} />
      <MyTeams showEmpty={false} />
    </div>
  );
}

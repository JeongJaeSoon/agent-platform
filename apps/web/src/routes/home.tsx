import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { agentsQuery, invitesQuery, membersQuery } from "../api/queries.ts";
import { useMe } from "../auth/guard.tsx";
import { type MessageKey, useI18n } from "../i18n/i18n.tsx";
import { useServices } from "../services.tsx";

/** Done, not yet, or not knowable here (the list refused this viewer, or failed). */
type StepState = "done" | "pending" | "unknown";

interface Step {
  readonly key: MessageKey;
  readonly state: StepState;
  readonly to?: "/members" | "/agents";
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
 * ready once one has an active release. The session step waits for the
 * session screens (I1).
 */
export function HomeScreen() {
  const { t } = useI18n();
  const me = useMe();
  const { client } = useServices();
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
    { key: "home.checklist.session", state: "pending" },
  ];
  return (
    <div className="web-home">
      <h1 className="web-home__title">
        {me?.workspace?.name ?? t("home.title")}
      </h1>
      {me?.user ? (
        <p className="web-home__who">
          {t("home.signedInAs", {
            name: me.user.display_name,
            email: me.user.email,
          })}
        </p>
      ) : null}
      <section className="web-checklist" aria-labelledby={checklistTitle}>
        <h2 id={checklistTitle}>{t("home.checklist.title")}</h2>
        <ol>
          {steps.map((step) => (
            <li
              key={step.key}
              className="web-checklist__step"
              data-done={step.state === "done"}
              data-state={step.state}
            >
              <span className="web-checklist__mark" aria-hidden="true">
                {MARK[step.state]}
              </span>
              {step.to ? (
                <Link to={step.to}>{t(step.key)}</Link>
              ) : (
                <span>{t(step.key)}</span>
              )}
              <span className="web-checklist__state">
                {t(STATE_KEY[step.state])}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

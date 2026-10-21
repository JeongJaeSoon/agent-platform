import { type ApiError, isApiError } from "@agent-platform/client";
import type { Agent } from "@agent-platform/contracts";
import { useAgentPlatform } from "@agent-platform/react";
import { Badge, type BadgeProps, formatTimestamp } from "@agent-platform/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { agentsQuery } from "../api/queries.ts";
import {
  permissionReason,
  ReasonButton,
  useHasPermission,
  useRole,
} from "../auth/guard.tsx";
import { AdministeredAgents } from "../components/agent-admins.tsx";
import { LoadFailure } from "../components/load-failure.tsx";
import { NewAgentFlow } from "../components/new-agent-flow.tsx";
import { StatusScreen } from "../components/status-screen.tsx";
import { errorKey, type Translate, useI18n } from "../i18n/i18n.tsx";

// The release check's model refusal (release-ids.ts), as "<field>: <message>".
const MODEL_REFUSAL =
  /^card\.model: model (.+) is not the model of runtime profile (.+)$/;

/**
 * What a refused agent action says: a 403 in the words of the disabled
 * button, a model mismatch in our words, any other capability the profile
 * does not have with the server's reason.
 */
export function agentRefusal(
  t: Translate,
  error: ApiError,
  role: string | undefined,
): string {
  if (error.code === "FORBIDDEN")
    return permissionReason(t, "agent.manage", role);
  // Only making an agent answers this: its slug is taken.
  if (error.code === "ALREADY_EXISTS") return t("agents.slugTaken");
  const model =
    error.code === "UNSUPPORTED_CAPABILITY"
      ? MODEL_REFUSAL.exec(error.message)
      : null;
  if (model)
    return t("agent.releases.modelRefused", {
      card: model[1] ?? "",
      profile: model[2] ?? "",
    });
  if (error.code === "UNSUPPORTED_CAPABILITY" || error.code === "BAD_REQUEST")
    return `${t(errorKey(error.code))} ${error.message}`;
  return t(errorKey(error.code));
}

export function AgentsScreen() {
  const { t, locale } = useI18n();
  const { client } = useAgentPlatform();
  const navigate = useNavigate();
  const role = useRole();
  const agents = useQuery(agentsQuery(client));
  // Making an agent needs less than listing them all: a member makes one and
  // becomes its admin.
  const reason = useHasPermission("agent.create")
    ? undefined
    : permissionReason(t, "agent.create", role);
  const failed = agents.isError && !isApiError(agents.error, "FORBIDDEN");

  return (
    <div className="web-page">
      <div className="web-page__head">
        <h1 className="web-page__title">{t("agents.title")}</h1>
        {failed ? null : (
          <ReasonButton
            className="ap-button ap-button--primary"
            reason={reason}
            onClick={() => void navigate({ to: "/agents/new" })}
          >
            {t("agents.new")}
          </ReasonButton>
        )}
      </div>
      {agents.isPending ? (
        <StatusScreen kind="loading" />
      ) : agents.error ? (
        isApiError(agents.error, "FORBIDDEN") ? (
          <>
            <p className="web-page__intro">{t("agents.listWithheld")}</p>
            <AdministeredAgents showEmpty />
          </>
        ) : (
          <LoadFailure
            error={agents.error}
            onRetry={() => void agents.refetch()}
          />
        )
      ) : agents.data.items.length === 0 ? (
        <p className="web-page__empty">{t("agents.empty")}</p>
      ) : (
        <ul className="web-list">
          {agents.data.items.map((agent) => (
            <li key={agent.id} className="web-list__item">
              <span>
                <Link
                  to="/agents/$id"
                  params={{ id: agent.id }}
                  className="web-table__primary"
                >
                  {agent.name}
                </Link>
                <span className="web-table__secondary">
                  {agent.slug} ·{" "}
                  {t("agents.updated", {
                    at: formatTimestamp(agent.updated_at, locale),
                  })}
                </span>
              </span>
              <AgentStateBadge agent={agent} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type AgentState = "draft" | Agent["status"];
type AgentSummary = Pick<Agent, "status" | "active_release_id">;

/** An agent never released is a draft, whatever its status; archived wins. */
export function agentState(agent: AgentSummary): AgentState {
  if (agent.status === "archived") return "archived";
  return agent.active_release_id === null ? "draft" : agent.status;
}

const STATE_VARIANT = {
  draft: "outline",
  active: "default",
  paused: "secondary",
  archived: "outline",
} as const satisfies Record<AgentState, BadgeProps["variant"]>;

function AgentStateBadge({ agent }: { readonly agent: AgentSummary }) {
  const { t } = useI18n();
  const state = agentState(agent);
  return (
    <Badge
      variant={STATE_VARIANT[state]}
      data-state={state}
      className={state === "archived" ? "text-muted-foreground" : undefined}
    >
      {state === "draft"
        ? t("agents.state.draft")
        : t(`agents.status.${state}`)}
    </Badge>
  );
}

/**
 * A blank card, made in steps. One-line hiring (a model drafting the card)
 * is 94S-156's and adds its button here when it lands.
 */
export function NewAgentScreen() {
  const { t } = useI18n();
  const role = useRole();
  const refuse = (error: unknown) =>
    isApiError(error) ? agentRefusal(t, error, role) : t(errorKey("UNKNOWN"));
  return (
    <div className="web-page">
      <h1 className="web-page__title">{t("agents.newTitle")}</h1>
      <p className="web-page__empty">{t("agents.newIntro")}</p>
      <NewAgentFlow refuse={refuse} />
    </div>
  );
}

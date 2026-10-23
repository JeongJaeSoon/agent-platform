import type { Agent } from "@werft-ai/contracts";
import { Badge, type BadgeProps } from "@werft-ai/ui";
import { useI18n } from "../i18n/i18n.tsx";

type AgentState = "draft" | Agent["status"];
type AgentSummary = Pick<Agent, "status" | "active_release_id">;

/** An agent never released is a draft, whatever its status; archived wins. */
export function agentState(agent: AgentSummary): AgentState {
  if (agent.status === "archived") return "archived";
  return agent.active_release_id === null ? "draft" : agent.status;
}

const STATE_VARIANT = {
  draft: "gray",
  active: "green",
  paused: "gray",
  archived: "gray",
} as const satisfies Record<AgentState, BadgeProps["variant"]>;

export function AgentStateBadge({ agent }: { readonly agent: AgentSummary }) {
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

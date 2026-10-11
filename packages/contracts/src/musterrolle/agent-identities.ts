import { z } from "zod";

// "This Slack app and bot is this agent" (design 1, A.2). An identity row
// pins one agent to one Slack install; v1 has the Slack bot only. Rows are
// revoked, never deleted or reopened: linking again makes a new row.

export const AGENT_IDENTITY_PROVIDER_VALUES = ["slack_bot"] as const;
export const agentIdentityProviderSchema = z.enum(
  AGENT_IDENTITY_PROVIDER_VALUES,
);

export const AGENT_IDENTITY_STATUS_VALUES = ["active", "revoked"] as const;
export const agentIdentityStatusSchema = z.enum(AGENT_IDENTITY_STATUS_VALUES);

/**
 * Why a Slack event moves no agent. Every reason is a drop: the event is
 * acknowledged and nothing runs.
 * - `not_installed`: no install for the event's app in that team.
 * - `installation_unverified`: installed, but `auth.test` has not answered.
 * - `installation_revoked`: the app was uninstalled or revoked.
 * - `unidentified`: the install names no agent, now or before.
 * - `identity_revoked`: the install's agent identity was revoked.
 * - `bot_mismatch`: the install now answers as another bot than the one the
 *   identity pinned, so a reinstall needs a new link.
 * - `agent_mismatch`: the event came in for another agent than the one the
 *   app belongs to.
 * - `agent_archived`: the app's agent is archived.
 */
export const SLACK_EVENT_DROP_REASON_VALUES = [
  "not_installed",
  "installation_unverified",
  "installation_revoked",
  "unidentified",
  "identity_revoked",
  "bot_mismatch",
  "agent_mismatch",
  "agent_archived",
] as const;
export const slackEventDropReasonSchema = z.enum(
  SLACK_EVENT_DROP_REASON_VALUES,
);

export type AgentIdentityProvider = z.infer<typeof agentIdentityProviderSchema>;
export type AgentIdentityStatus = z.infer<typeof agentIdentityStatusSchema>;
export type SlackEventDropReason = z.infer<typeof slackEventDropReasonSchema>;

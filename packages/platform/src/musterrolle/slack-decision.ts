import {
  type AuthorizationDecision,
  type AuthorizationSubject,
  INSTALLATION_SESSION_SCOPE_VALUES,
  type SlackEventDropReason,
  type SlackNotice,
  type SlackSurfaceAction,
  type SlackUser,
  type SurfaceCeiling,
  type SurfaceChannelKind,
  slackNoticeFor,
  slackUserKindOf,
} from "@agent-platform/contracts";
import type {
  AgentIdentityStore,
  SlackEventKey,
} from "../ports/agent-identity-store.ts";
import type { LinkedAccountStore } from "../ports/linked-account-store.ts";
import { agentForSlackEvent } from "./agent-identity-service.ts";
import type { AuthorizationPolicy } from "./policy.ts";

export type SlackInput = {
  /** The event's app and team, and the agent its request URL names. */
  event: SlackEventKey & { agentId?: string };
  /** Who typed, or who pressed the button — never the thread's requester. */
  user: SlackUser;
  action: SlackSurfaceAction;
  /**
   * A new conversation is asked of the binding (`id` null until bindings
   * are stored); a follow-up or a button, of its session.
   */
  resource:
    | { kind: "surface_binding"; id: string | null; releaseId?: string }
    | { kind: "session" | "session_link"; id: string };
  /** The channel's binding, handed in until 94S-177 stores it. */
  binding: {
    id?: string;
    channelKind: SurfaceChannelKind;
    ceiling: SurfaceCeiling;
  };
  requestId: string;
  /** The web page where a person links their Slack account. */
  connectUrl: string;
};

export type SlackDecision =
  // Not this agent's app, or the app is gone: nothing runs and nobody is told.
  | { status: "dropped"; reason: SlackEventDropReason }
  | {
      status: "decided";
      workspaceId: string;
      agentId: string;
      decision: AuthorizationDecision;
      /** Who the input is recorded as; set only when it may proceed. */
      actorUserId: string | null;
      /** What to show the person alone, once per thread; null for none. */
      notice: SlackNotice | null;
    };

/**
 * The whole Musterrolle half of a Slack mention or button (design 3.2):
 * the agent the app belongs to, the person the Slack account links to now,
 * then the decision and the notice for a refusal. The Slack channel calls
 * this once per input it processes and for every button press, with the
 * person who pressed it.
 */
export async function authorizeSlackInput(
  deps: {
    authorization: AuthorizationPolicy;
    agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
    links: Pick<LinkedAccountStore, "resolveLinkedSubject">;
  },
  input: SlackInput,
): Promise<SlackDecision> {
  const agent = await agentForSlackEvent(deps.agents, input.event);
  if (agent.status === "dropped") {
    return { status: "dropped", reason: agent.reason };
  }
  const { workspaceId, agentId } = agent;

  const linked = await deps.links.resolveLinkedSubject({
    provider: "slack",
    externalTenant: input.event.teamId,
    externalUserId: input.user.id,
  });
  const subject: AuthorizationSubject = {
    principal: {
      kind: "installation",
      id: agent.installationId,
      // An installation's partition is its workspace's.
      owner_id: workspaceId,
      workspace_id: workspaceId,
      scopes: [...INSTALLATION_SESSION_SCOPE_VALUES],
    },
    // Passed even when stale or offboarded, so the decision names why.
    ...(linked.status === "unlinked"
      ? {}
      : {
          actor_user_id: linked.userId,
          linked_account: linked.linkedAccount,
        }),
    surface: {
      kind: "slack",
      ...(input.binding.id === undefined
        ? {}
        : { binding_id: input.binding.id }),
      channel_kind: input.binding.channelKind,
      slack_user_kind: slackUserKindOf(input.user, input.event.teamId),
      ceiling: input.binding.ceiling,
    },
  };
  const { resource } = input;
  const decision = await deps.authorization.authorize({
    subject,
    action: input.action,
    resource:
      resource.kind === "surface_binding" && resource.id === null
        ? {
            kind: "surface_binding",
            id: null,
            owner_scope: workspaceId,
            agent_id: agentId,
            ...(resource.releaseId === undefined
              ? {}
              : { release_id: resource.releaseId }),
          }
        : { kind: resource.kind, id: resource.id, owner_scope: workspaceId },
    request_id: input.requestId,
  });
  return {
    status: "decided",
    workspaceId,
    agentId,
    decision,
    actorUserId:
      decision.outcome !== "deny" && linked.status === "linked"
        ? linked.userId
        : null,
    notice: slackNoticeFor(decision, input.action, {
      connectUrl: input.connectUrl,
    }),
  };
}

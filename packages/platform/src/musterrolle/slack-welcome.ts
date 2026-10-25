import {
  type AgentRelease,
  SLACK_BINDING_LIST_LIMIT,
  type SlackFinalizeWarning,
  type SurfaceMembership,
} from "@werft-ai/contracts";
import type { AgentStore } from "../ports/agent-store.ts";
import type { SlackAppStore } from "../ports/slack-app-store.ts";
import type {
  SlackOutboxEntry,
  SlackOutboxStore,
} from "../ports/slack-outbox-store.ts";
import type { SurfaceBindingStore } from "../ports/surface-binding-store.ts";
import type { SlackChannelJoiner } from "./slack-channel-join.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import type { SlackInstallFinalize } from "./slack-install-service.ts";

/** The welcome's words; the outbox escapes them, so a name mentions no one. */
export function slackWelcomeText(agentName: string): string {
  return `안녕하세요, ${agentName}입니다. 이 채널에 배포됐어요. 멘션하면 답할게요`;
}

/**
 * One welcome per release and home: the same definition again, a rollback
 * to a release already announced, or a home moved back all find it taken.
 */
export function deploymentWelcomeKey(
  agentId: string,
  releaseId: string,
  homeBindingId: string,
): string {
  return `deployment-welcome:${agentId.toLowerCase()}:${releaseId}:${homeBindingId.toLowerCase()}`;
}

/** Every path that welcomes builds its row here. */
export function deploymentWelcome(input: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  releaseId: string;
  slackAppId: string;
  installationId: string;
  homeBindingId: string;
  channelId: string;
}): SlackOutboxEntry {
  return {
    workspaceId: input.workspaceId,
    agentId: input.agentId.toLowerCase(),
    slackAppId: input.slackAppId,
    installationId: input.installationId,
    kind: "welcome",
    channelId: input.channelId,
    threadTs: "",
    slackUserId: null,
    sessionId: null,
    body: { text: slackWelcomeText(input.agentName) },
    dedupeKey: deploymentWelcomeKey(
      input.agentId,
      input.releaseId,
      input.homeBindingId,
    ),
  };
}

/**
 * `unknown_membership`: Slack was not asked, or did not answer, whether the
 * bot is in the home. The membership states say why nothing was enqueued:
 * a row for a channel the bot is not in would fail for good.
 */
export type SlackWelcomeOutcome =
  | { status: "enqueued" | "duplicate"; channelId: string }
  | {
      status: Exclude<SurfaceMembership["state"], "joined">;
      channelId: string;
      error: string | null;
    }
  | { status: "unknown_membership"; channelId: string }
  | { status: "no_home" | "no_release" | "not_installed" };

export type SlackWelcome = ReturnType<typeof createSlackWelcome>;

// What asking Slack again can change.
const WAITING_ON_SLACK = new Set<SlackWelcomeOutcome["status"]>([
  "unknown_membership",
  "awaiting_invite",
  "config_error",
  "join_failed",
]);

/**
 * Finalize ②: the agent's home channel hears once per release. Joining a
 * public home comes first; a private one waits for the invite.
 */
export function createSlackWelcome(deps: {
  agents: Pick<AgentStore, "get" | "findRelease">;
  bindings: Pick<SurfaceBindingStore, "list">;
  apps: Pick<SlackAppStore, "findForAgent">;
  outbox: Pick<SlackOutboxStore, "enqueue">;
  /** Null without a bot token source: membership is only what was stored. */
  join: SlackChannelJoiner | null;
  logger: SlackInboxLogger;
}) {
  /**
   * `ask`: ask Slack (and join) before deciding; otherwise only the stored
   * membership counts, so nothing but the database is read.
   */
  async function welcome(
    workspaceId: string,
    agentId: string,
    options: { releaseId?: string; ask: boolean },
  ): Promise<SlackWelcomeOutcome> {
    const [home] = await deps.bindings.list(workspaceId, agentId, 1);
    if (
      home === undefined ||
      !home.home ||
      home.mode === "off" ||
      home.channelId === null ||
      home.installationId === null
    ) {
      return { status: "no_home" };
    }
    const channelId = home.channelId;
    let membership = home.membership;
    if (options.ask && deps.join !== null) {
      membership = (await deps.join(home)) ?? membership;
    }
    if (membership === null) return { status: "unknown_membership", channelId };
    if (membership.state !== "joined") {
      return { status: membership.state, channelId, error: membership.error };
    }
    const detail = await deps.agents.get(workspaceId, agentId);
    const releaseId = options.releaseId ?? detail?.agent.active_release_id;
    if (!detail || !releaseId) return { status: "no_release" };
    const app = await deps.apps.findForAgent(workspaceId, agentId);
    if (app === null) return { status: "not_installed" };
    const status = await deps.outbox.enqueue(
      deploymentWelcome({
        workspaceId,
        agentId,
        agentName: detail.agent.name,
        releaseId,
        slackAppId: app.id,
        installationId: home.installationId,
        homeBindingId: home.id,
        channelId,
      }),
    );
    return { status, channelId };
  }

  const logOutcome = (
    agentId: string,
    releaseId: string,
    outcome: SlackWelcomeOutcome,
  ) => {
    if (outcome.status === "enqueued" || outcome.status === "duplicate") return;
    deps.logger.info("Deployment welcome not enqueued", {
      agent_id: agentId,
      release_id: releaseId,
      ...outcome,
    });
  };

  return {
    welcome,

    /**
     * The install's Finalize ②: every bound channel is joined (or found
     * waiting), then the home hears the active release. What the bot is
     * not in yet comes back as warnings naming the channel.
     */
    finalize: (async (installed) => {
      const warnings: SlackFinalizeWarning[] = [];
      const bindings = await deps.bindings.list(
        installed.workspaceId,
        installed.agentId,
        SLACK_BINDING_LIST_LIMIT,
      );
      for (const binding of bindings) {
        if (binding.channelId === null || deps.join === null) continue;
        const membership = await deps.join(binding);
        if (membership !== null && membership.state !== "joined") {
          warnings.push({
            code: membership.state,
            channel_id: binding.channelId,
            ...(membership.error === null ? {} : { error: membership.error }),
          });
        }
      }
      await welcome(installed.workspaceId, installed.agentId, { ask: false });
      return { finalized: true, warnings };
    }) satisfies SlackInstallFinalize,

    /**
     * A release went live. A rollback, to a release older than the one it
     * replaced, says nothing, even when that release was never announced.
     * The row is enqueued before this returns when the bot is known to be
     * in the home; otherwise Slack is asked after, so the activation never
     * waits on it. Never throws: a welcome that cannot go is logged and
     * left on the binding.
     */
    async activated(
      workspaceId: string,
      agentId: string,
      release: Pick<AgentRelease, "id" | "created_at">,
      previousReleaseId: string | null,
    ): Promise<SlackWelcomeOutcome | "rollback" | null> {
      const releaseId = release.id;
      try {
        if (previousReleaseId !== null) {
          const previous = await deps.agents.findRelease(
            workspaceId,
            previousReleaseId,
          );
          if (
            previous &&
            Date.parse(release.created_at) < Date.parse(previous.created_at)
          ) {
            return "rollback";
          }
        }
        const outcome = await welcome(workspaceId, agentId, {
          releaseId,
          ask: false,
        });
        if (!WAITING_ON_SLACK.has(outcome.status) || deps.join === null) {
          logOutcome(agentId, releaseId, outcome);
          return outcome;
        }
        void welcome(workspaceId, agentId, { releaseId, ask: true }).then(
          (asked) => logOutcome(agentId, releaseId, asked),
          (error: unknown) =>
            deps.logger.warn("Deployment welcome failed", {
              agent_id: agentId,
              release_id: releaseId,
              error: error instanceof Error ? error.message : String(error),
            }),
        );
        return outcome;
      } catch (error) {
        deps.logger.warn("Deployment welcome failed", {
          agent_id: agentId,
          release_id: releaseId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}

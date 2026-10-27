import {
  formatSurfaceRef,
  messageTextSchema,
  SLACK_NOTICE_MESSAGES,
  type SlackNotice,
  type SurfaceChannelKind,
  slackNoticeFor,
} from "@werft-ai/contracts";
import { z } from "zod";
import type { AgentIdentityStore } from "../ports/agent-identity-store.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import type { LinkedAccountStore } from "../ports/linked-account-store.ts";
import type {
  SessionLinkRecord,
  SessionLinkStore,
} from "../ports/session-link-store.ts";
import type { SlackInboundEventStore } from "../ports/slack-inbound-event-store.ts";
import type { SlackNoticeSink } from "../ports/slack-notice-sink.ts";
import type { SurfaceBindingStore } from "../ports/surface-binding-store.ts";
import {
  type SessionService,
  SessionServiceError,
} from "../sessions/session-service.ts";
import { agentForSlackEvent } from "./agent-identity-service.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import {
  authorizeSlackInput,
  type SlackInput,
  slackCallerOf,
} from "./slack-decision.ts";
import {
  SlackInboundDropped,
  type SlackInboundHandler,
  type SlackInboxLogger,
} from "./slack-inbox.ts";

const slackMessageSchema = z.object({
  type: z.enum(["app_mention", "message"]),
  channel: z.string().min(1),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  user: z.string().min(1),
  text: z.string().default(""),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  channel_type: z.string().optional(),
});

const CHANNEL_KIND_OF: Partial<Record<string, SurfaceChannelKind>> = {
  channel: "public_channel",
  group: "private_channel",
  mpim: "private_channel",
  im: "dm",
};

/** Answers that mean the workspace has no progress line to show. */
const SET_STATUS_SKIPPED = new Set([
  "not_authorized",
  "feature_disabled",
  "thread_ts_required",
]);

export const SLACK_PROCESSING_STATUS = "processing";

const RETRYABLE_SESSION_CODES = new Set([
  "RATE_LIMITED",
  "BACKEND_UNAVAILABLE",
]);

class SlackLeaseLost extends Error {
  constructor() {
    super("Slack event lease lost before its effects");
  }
}

/**
 * The text a turn gets: the bot's own mention taken out, with or without
 * the display name Slack may put after a `|`.
 */
export function withoutBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "")
    .trim();
}

export type SlackSessionHandlerDeps = {
  inbox: Pick<SlackInboundEventStore, "renew">;
  /** The lease each effect is held under, renewed just before it. */
  leaseMs: number;
  authorization: AuthorizationPolicy;
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  links: Pick<LinkedAccountStore, "resolveLinkedSubject">;
  bindings: Pick<
    SurfaceBindingStore,
    "resolveSlackChannel" | "ensureDmBinding"
  >;
  sessionLinks: SessionLinkStore;
  sessions: Pick<SessionService, "createSession" | "appendMessage">;
  /** The agent's active release, which a new thread's session runs. */
  agentDetails: Pick<AgentStore, "get">;
  /**
   * Slack names no repository, so a session gets the release's; true when
   * that cannot start (none for a profile that needs one, or it left the
   * catalog).
   */
  releaseRepositoryUnusable(
    workspaceId: string,
    releaseId: string,
  ): Promise<boolean>;
  slack: SlackBotApi;
  /** The app's bot token from the secret store; null when it has none. */
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  notices: SlackNoticeSink;
  logger: SlackInboxLogger;
  /** The web page where a person links their Slack account. */
  connectUrl: string;
  newRequestId?: () => string;
};

/**
 * The `slack` role's handler: a mention, a DM or a reply in a
 * linked thread becomes a turn of the thread's one session. A refusal
 * leaves a notice for 94S-792 and no session.
 */
export function createSlackSessionHandler(
  deps: SlackSessionHandlerDeps,
): SlackInboundHandler {
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());

  return async (claim) => {
    const parsed = slackMessageSchema.safeParse(
      (claim.payload as { event?: unknown }).event,
    );
    // Not a channel message: 94S-794 acts on a bot's own channel join.
    if (!parsed.success) return;
    const event = parsed.data;
    const ids = { id: claim.id, event_id: claim.eventId };
    if (
      event.bot_id !== undefined ||
      (event.subtype !== undefined && event.subtype !== "thread_broadcast")
    ) {
      return;
    }
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped") {
      deps.logger.info("Slack event names no agent of this app; ignored", {
        ...ids,
        reason: agent.reason,
      });
      return;
    }
    if (event.user === agent.botUserId) return;

    const dm = event.channel_type === "im";
    const threadTs = event.thread_ts ?? event.ts;
    const surfaceRef = formatSurfaceRef(event.channel, threadTs);
    const found = await deps.sessionLinks.find(
      agent.installationId,
      surfaceRef,
    );
    if (found !== null && found.revokedAt !== null) return;
    const mentioned =
      event.type === "app_mention" ||
      new RegExp(`<@${agent.botUserId}(?:\\||>)`).test(event.text);
    const binding = dm
      ? await deps.bindings.ensureDmBinding(agent.installationId)
      : await deps.bindings.resolveSlackChannel(
          agent.installationId,
          event.channel,
        );
    // An ambient channel takes a person's top-level message unmentioned,
    // never a reply in a thread the agent is not part of.
    const ambient =
      binding?.mode === "ambient" && event.thread_ts === undefined;
    if (found === null && !mentioned && !dm && !ambient) return;
    const botToken = await deps.botToken(claim.workspaceId, claim.slackAppId);
    if (botToken === null) {
      throw new Error("The Slack app has no bot token stored");
    }
    const user = await deps.slack.userInfo(botToken, event.user);
    const notice = async (reason: string, text: SlackNotice) => {
      // Someone talking in an ambient channel did not ask the agent, so a
      // refusal is not theirs to read on every message.
      if (found === null && !mentioned && !dm) return;
      await deps.notices.record({
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        slackAppId: claim.slackAppId,
        teamId: claim.teamId,
        channelId: event.channel,
        threadTs,
        slackUserId: event.user,
        reason,
        notice: text,
        onceKey: `${agent.installationId}:${surfaceRef}:${event.user}`,
      });
    };

    // A channel whose kind Slack now reports otherwise than the binding was
    // set for is not the place the binding allowed (DECIDED 11).
    // `app_mention` carries no `channel_type`: Slack is asked instead.
    const eventKind =
      event.channel_type !== undefined
        ? CHANNEL_KIND_OF[event.channel_type]
        : binding !== null && binding.channelKind !== "dm"
          ? await deps.slack.channelKind(botToken, event.channel)
          : undefined;
    if (
      binding !== null &&
      eventKind !== undefined &&
      binding.channelKind !== eventKind
    ) {
      deps.logger.warn("Slack channel kind differs from its binding; refused", {
        ...ids,
        binding_kind: binding.channelKind,
        event_kind: eventKind,
      });
      const refused = slackNoticeFor(
        { outcome: "deny", reason_code: "surface_ceiling" },
        "session.submit",
        { connectUrl: deps.connectUrl },
      );
      if (refused !== null) await notice("channel_kind_mismatch", refused);
      return;
    }

    let release: { id: string; runtime_profile_id: string } | null = null;
    let resource: SlackInput["resource"];
    if (found === null) {
      const detail = await deps.agentDetails.get(
        agent.workspaceId,
        agent.agentId,
      );
      if (!detail?.active_release) {
        deps.logger.warn("Slack agent has no active release; refused", ids);
        await notice("no_active_release", {
          text: SLACK_NOTICE_MESSAGES.noActiveRelease,
        });
        return;
      }
      release = detail.active_release;
      resource = { kind: "surface_binding", releaseId: release.id };
    } else {
      resource = { kind: "session_link", id: found.id };
    }
    const requestId = newRequestId();
    const decision = await authorizeSlackInput(deps, {
      event: {
        appId: claim.appId,
        teamId: claim.teamId,
        agentId: claim.agentId,
      },
      user,
      action: "session.submit",
      channel: { id: event.channel, dm },
      resource,
      requestId,
      connectUrl: deps.connectUrl,
    });
    if (decision.status === "dropped") return;
    if (decision.decision.outcome !== "allow") {
      // The decision itself failed, not the person: try the event again.
      if (decision.decision.reason_code === "error") {
        throw new Error("Slack input decision failed");
      }
      deps.logger.info("Slack input refused", {
        ...ids,
        reason: decision.decision.reason_code,
      });
      if (decision.notice !== null) {
        await notice(decision.decision.reason_code, decision.notice);
      }
      return;
    }

    const message = withoutBotMention(event.text, agent.botUserId);
    if (!messageTextSchema.safeParse(message).success) {
      deps.logger.info("Slack message has no text to send; ignored", ids);
      return;
    }
    const caller = slackCallerOf(decision, requestId);

    const held = await deps.inbox.renew(claim, deps.leaseMs);
    if (held === null) throw new SlackLeaseLost();
    if (held.installationStatus === "revoked") {
      throw new SlackInboundDropped("installation_revoked");
    }

    let link: SessionLinkRecord;
    if (found !== null) {
      link = found;
    } else {
      if (binding === null || release === null) {
        throw new Error("The channel's binding is gone since the decision");
      }
      link = (
        await deps.sessionLinks.reserve({
          workspaceId: agent.workspaceId,
          installationId: agent.installationId,
          surfaceBindingId: binding.id,
          surfaceRef,
          channelId: event.channel,
          threadId: threadTs,
          openedByTs: event.ts,
          agentId: agent.agentId,
          releaseId: release.id,
          profileId: release.runtime_profile_id,
          createdBy: decision.actorUserId,
        })
      ).link;
    }
    try {
      if (link.sessionId === null && link.openedByTs !== event.ts) {
        link = await adoptOrReopen(link, event.ts);
      }
      if (link.sessionId === null || link.openedByTs === event.ts) {
        await openSession(caller, link, message, dm);
      } else {
        await deps.sessions.appendMessage(caller, link.sessionId, {
          idempotencyKey: `${claim.teamId}:${event.channel}:${event.ts}`,
          body: { message, mode: "enqueue" },
        });
      }
      // After the effects, so nothing slow sits between the lease's renewal
      // and the session's write.
      await setProcessing(botToken, event.channel, threadTs, ids);
    } catch (error) {
      if (
        !(error instanceof SessionServiceError) ||
        RETRYABLE_SESSION_CODES.has(error.code)
      ) {
        throw error;
      }
      deps.logger.warn("Slack input refused by the session", {
        ...ids,
        code: error.code,
      });
      if (
        error.code === "UNSUPPORTED_CAPABILITY" &&
        (await deps.releaseRepositoryUnusable(
          agent.workspaceId,
          link.releaseId,
        ))
      ) {
        await notice("repository_required", {
          text: SLACK_NOTICE_MESSAGES.repositoryRequired,
        });
      } else if (error.code === "PROFILE_DIGEST_MISMATCH") {
        await notice("profile_unavailable", {
          text: SLACK_NOTICE_MESSAGES.profileUnavailable,
        });
      } else {
        await notice(error.code, { text: SLACK_NOTICE_MESSAGES.failed });
      }
    }
  };

  /**
   * The link's opening message gave out before the link learned its
   * session: keep the session it made, or let this message open one.
   */
  async function adoptOrReopen(
    link: SessionLinkRecord,
    ts: string,
  ): Promise<SessionLinkRecord> {
    const made = await deps.sessionLinks.openedSession(link);
    if (made !== null) return deps.sessionLinks.attachSession(link.id, made);
    deps.logger.warn("Slack thread's opening message ran out; reopened", {
      link_id: link.id,
    });
    return deps.sessionLinks.reopen(link.id, ts);
  }

  async function openSession(
    caller: Caller,
    link: SessionLinkRecord,
    message: string,
    dm: boolean,
  ): Promise<void> {
    const created = await deps.sessions.createSession(caller, {
      idempotencyKey: link.id,
      body: {
        profile_id: link.profileId,
        agent_release_id: link.releaseId,
        message,
      },
      ...(dm ? { shareScope: "private" as const } : {}),
    });
    const attached = await deps.sessionLinks.attachSession(
      link.id,
      created.session_id,
    );
    if (attached.sessionId !== created.session_id) {
      throw new Error(`Slack thread ${link.id} already holds another session`);
    }
  }

  async function setProcessing(
    botToken: string,
    channelId: string,
    threadTs: string,
    ids: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.slack.setStatus(botToken, {
        channelId,
        threadTs,
        status: SLACK_PROCESSING_STATUS,
      });
    } catch (error) {
      const code = error instanceof SlackApiError ? error.code : "error";
      if (SET_STATUS_SKIPPED.has(code)) {
        deps.logger.info("Slack status not shown", { ...ids, code });
      } else {
        deps.logger.warn("Slack status failed; going on", { ...ids, code });
      }
    }
  }
}

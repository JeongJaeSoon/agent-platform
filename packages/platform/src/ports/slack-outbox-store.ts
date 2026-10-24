import type { SlackNotice } from "@werft-ai/contracts";

/**
 * `reply`: a turn's answer in its thread. `failure_notice`: a turn the model
 * could not finish, or a reply whose send nobody can vouch for. `input_notice`:
 * a turn waiting on an approval only the web can give. `notice`: a refusal,
 * ephemeral to the person who typed.
 */
export type SlackOutboxKind =
  | "reply"
  | "notice"
  | "failure_notice"
  | "input_notice";

/**
 * `uncertain`: the send was under way when its lease ran out or its answer
 * never came, so Slack may hold the message; it is never sent again.
 */
export type SlackOutboxStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain";

/**
 * What goes out, before Slack controls are escaped. `mention_user_ids`: the
 * only Slack users the text may notify (a reply's requester).
 */
export type SlackOutboxBody = SlackNotice & {
  mention_user_ids?: string[];
};

export type SlackOutboxEntry = {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  kind: SlackOutboxKind;
  channelId: string;
  threadTs: string;
  /** The ephemeral's reader; set exactly for `notice`. */
  slackUserId: string | null;
  /** The session the console link opens; null for a refusal. */
  sessionId: string | null;
  body: SlackOutboxBody;
  /** The same key twice enqueues once. */
  dedupeKey: string;
};

export type SlackOutboxFence = { id: string; claimToken: string };

export type SlackOutboxClaim = SlackOutboxEntry &
  SlackOutboxFence & {
    /** Claims so far, this one included. */
    attempts: number;
  };

/** A row the lease ran out on mid-send, now `uncertain`. */
export type SlackOutboxLost = SlackOutboxEntry & { id: string };

/** Where a linked session's turns answer: the link's thread. */
export type SlackLinkedTurnTarget = {
  sessionLinkId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  installationId: string;
  channelId: string;
  threadTs: string;
};

/**
 * A turn of a live linked session that has no outbox row of its kind yet.
 * `ended` holds a terminal status; `needs_input` is a running turn with a
 * pending request a client can still answer.
 */
export type SlackUnansweredTurn = SlackLinkedTurnTarget & {
  /** The public turn id, 1-based within the session. */
  turnId: number;
  state: "completed" | "failed" | "needs_input";
  /** The Slack account linked to whoever asked for the turn, if any. */
  requesterSlackUserId: string | null;
  /**
   * The final attempt's top-level assistant and tool_use event payloads,
   * in order; empty unless the turn completed.
   */
  events: { type: string; payload: unknown }[];
};

export type SlackOutboxSettle =
  | { status: "sent"; slackTs: string }
  | { status: "failed"; errorCode: string }
  | { status: "uncertain"; errorCode: string }
  | { status: "pending"; retryInMs: number; errorCode: string };

export interface SlackOutboxStore {
  enqueue(entry: SlackOutboxEntry): Promise<"enqueued" | "duplicate">;
  /** Linked turns that ended or wait on input without their outbox row. */
  unansweredTurns(limit: number): Promise<SlackUnansweredTurn[]>;
  /** Moves `sending` rows whose lease ran out to `uncertain`. */
  expireSending(): Promise<SlackOutboxLost[]>;
  /** `uncertain` replies whose thread has not been told so yet. */
  untoldUncertain(limit: number): Promise<SlackOutboxLost[]>;
  /**
   * Due `pending` rows under a lease from the database clock. They stay
   * `pending` until beginSend, so a crash before the send is claimed again.
   */
  claim(input: { limit: number; leaseMs: number }): Promise<SlackOutboxClaim[]>;
  /** `sending` from here on: a lease that runs out now leaves it `uncertain`. */
  beginSend(fence: SlackOutboxFence): Promise<boolean>;
  /** False when the lease was lost: the row is someone else's now. */
  settle(fence: SlackOutboxFence, outcome: SlackOutboxSettle): Promise<boolean>;
}

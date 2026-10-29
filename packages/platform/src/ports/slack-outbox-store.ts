import type { UserLocale } from "@werft-ai/contracts";

/**
 * `reply`: a turn's answer in its thread. `failure_notice`: a turn the model
 * could not finish, or a reply whose send nobody can vouch for. `input_notice`:
 * a turn waiting on an approval only the web can give. `notice`: a refusal,
 * ephemeral to the person who typed. `welcome`: a deployment's one message
 * in the agent's home channel, outside any thread (`threadTs` is "").
 * `instruction`: an input sent from the web or the API, shown in the thread
 * ahead of its answer.
 */
export type SlackOutboxKind =
  | "instruction"
  | "reply"
  | "notice"
  | "failure_notice"
  | "input_notice"
  | "welcome";

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
 * only Slack users the text may notify (a reply's requester). `sender`: the
 * name an instruction is shown under, and the Slack account whose profile
 * image goes with it. `locale`: the language of the words the platform adds,
 * the link's label included; rows from before it have none and read Korean.
 */
export type SlackOutboxBody = {
  text: string;
  link_url?: string;
  locale?: UserLocale;
  mention_user_ids?: string[];
  sender?: { username: string; slack_user_id?: string };
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
    /**
     * Attempts so far, this one included. A claim whose lease lapses before
     * beginSend or settle does not count.
     */
    attempts: number;
  };

/** A row the lease ran out on mid-send, now `uncertain`. */
export type SlackOutboxLost = SlackOutboxEntry & { id: string };

/**
 * Where a linked session's turns answer: the link's thread. `locale`: that
 * of whoever started the session, whom the thread is in their language for.
 */
export type SlackLinkedTurnTarget = {
  locale: UserLocale | null;
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

/**
 * A turn of a live linked session asked from the web or the API that the
 * thread has not been shown yet.
 */
export type SlackUnpostedInstruction = SlackLinkedTurnTarget & {
  turnId: number;
  channel: "web" | "api";
  message: string;
  /** Who sent it; null for an API key no person created. */
  senderName: string | null;
  /** The Slack account linked to the sender, if any. */
  senderSlackUserId: string | null;
};

export type SlackOutboxSettle =
  | { status: "sent"; slackTs: string }
  | { status: "failed"; errorCode: string }
  | { status: "uncertain"; errorCode: string }
  | { status: "pending"; retryInMs: number; errorCode: string };

export interface SlackOutboxStore {
  /**
   * `whileHome`: insert only while that binding is the agent's live home
   * and that release is active, checked under share locks so a home move
   * or an activation committing meanwhile is waited for, not missed.
   */
  enqueue(
    entry: SlackOutboxEntry,
    whileHome?: { bindingId: string; releaseId: string },
  ): Promise<"enqueued" | "duplicate" | "not_home">;
  /** The language of the user that Slack account is linked to, if any. */
  readerLocale(reader: {
    workspaceId: string;
    teamId: string;
    slackUserId: string;
  }): Promise<UserLocale | null>;
  /**
   * Moves each live link's mark past the turns that need nothing more: those
   * with their outbox row, interrupted or cancelled, or ended before the
   * link. A turn still running or waiting stops it. Returns links moved.
   */
  advanceAnswered(): Promise<number>;
  /**
   * Linked turns past the link's mark, asked from the web or the API after
   * the link, with no `instruction` row yet; neither cancelled nor
   * interrupted.
   */
  unpostedInstructions(limit: number): Promise<SlackUnpostedInstruction[]>;
  /**
   * Linked turns past the link's mark that ended or wait on input without
   * their outbox row. A turn that owes an `instruction` row waits for it,
   * so the answer never goes ahead of what it answers.
   */
  unansweredTurns(limit: number): Promise<SlackUnansweredTurn[]>;
  /** Moves `sending` rows whose lease ran out to `uncertain`. */
  expireSending(): Promise<SlackOutboxLost[]>;
  /**
   * Fails `pending` rows with nowhere left to go: a revoked installation, or
   * a link revoked, muted or turned to summary since the row was enqueued.
   */
  closeUnaddressed(): Promise<
    Pick<SlackOutboxLost, "id" | "kind" | "channelId">[]
  >;
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

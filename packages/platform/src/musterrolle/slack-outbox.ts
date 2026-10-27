import {
  eventText,
  eventToolCall,
  SLACK_NOTICE_MESSAGES,
} from "@werft-ai/contracts";
import type { SlackNoticeSink } from "../ports/slack-notice-sink.ts";
import type {
  SlackOutboxClaim,
  SlackOutboxEntry,
  SlackOutboxLost,
  SlackOutboxSettle,
  SlackOutboxStore,
  SlackUnansweredTurn,
  SlackUnpostedInstruction,
} from "../ports/slack-outbox-store.ts";
import {
  SlackApiError,
  type SlackBotApi,
  type SlackBotSender,
  type SlackSendResponse,
} from "./slack-config-api.ts";
import { type SlackInboxLogger, slackInboundBackoffMs } from "./slack-inbox.ts";
import { escapeSlackControls } from "./slack-presentation.ts";
import {
  classifySlackSendResult,
  SLACK_SEND_MAX_ATTEMPTS,
} from "./slack-send-result.ts";

/** chat.postMessage truncates `text` past this many characters. */
export const SLACK_TEXT_MAX = 40_000;
/** The longest Retry-After the outbox honours before asking again. */
export const SLACK_RETRY_AFTER_MAX_MS = 5 * 60_000;
/** Claims, rate-limited ones included, before a row gives up. */
export const SLACK_OUTBOX_MAX_ATTEMPTS = 10;

export const SLACK_OUTBOX_MESSAGES = {
  emptyReply: "답변을 마쳤어요. 내용은 웹에서 확인해 주세요",
  needsInput: "웹에서 승인이 필요해요",
  uncertain: "답을 보냈는지 확인하지 못했어요. 웹에서 확인해 주세요",
  link: "웹에서 열기",
  web: "웹 콘솔",
  api: "API",
} as const;

/** Slack cuts a `username` past this many characters. */
const SLACK_USERNAME_MAX = 80;

/**
 * Who an instruction came from, as its first line and its `username`: the
 * first line still says so in an app that cannot set the name.
 */
export function slackInstructionSender(
  channel: SlackUnpostedInstruction["channel"],
  senderName: string | null,
): string {
  const via = SLACK_OUTBOX_MESSAGES[channel];
  const name = senderName?.replace(/\s+/g, " ").trim();
  if (!name) return via;
  const suffix = ` (${via})`;
  return `${[...name].slice(0, SLACK_USERNAME_MAX - suffix.length).join("")}${suffix}`;
}

/** Enqueues the instructions sent from the web or the API, once each. */
export async function enqueueSlackInstructions(deps: {
  outbox: Pick<SlackOutboxStore, "unpostedInstructions" | "enqueue">;
  limit: number;
}): Promise<number> {
  const turns = await deps.outbox.unpostedInstructions(deps.limit);
  for (const turn of turns) {
    const username = slackInstructionSender(turn.channel, turn.senderName);
    await deps.outbox.enqueue({
      workspaceId: turn.workspaceId,
      agentId: turn.agentId,
      slackAppId: turn.slackAppId,
      installationId: turn.installationId,
      kind: "instruction",
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      slackUserId: null,
      sessionId: turn.sessionId,
      body: {
        text: `${username}\n${turn.message}`,
        sender:
          turn.senderSlackUserId === null
            ? { username }
            : { username, slack_user_id: turn.senderSlackUserId },
      },
      dedupeKey: `instruction:${turn.sessionLinkId}:${turn.turnId}`,
    });
  }
  return turns.length;
}

/** One outbox row per turn and kind: what makes a turn answered. */
export function slackTurnDedupeKey(
  state: SlackUnansweredTurn["state"],
  sessionLinkId: string,
  turnId: number,
): string {
  const prefix =
    state === "completed" ? "reply" : state === "failed" ? "failure" : "input";
  return `${prefix}:${sessionLinkId}:${turnId}`;
}

/**
 * The text the model wrote after its last tool call: what it said once the
 * work was done. Read whole, unlike presentTurnEvent's clipped summary.
 */
export function finalReplyText(events: SlackUnansweredTurn["events"]): string {
  let parts: string[] = [];
  for (const event of events) {
    if (eventToolCall(event.payload) !== null) parts = [];
    else {
      const text = eventText(event.payload);
      if (text !== null) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function isSafeLink(url: string): boolean {
  if (/[<>|\s]/.test(url)) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * What goes to Slack: the body with every control escaped, cut to fit with
 * its link kept whole after it.
 */
export function slackOutboxText(body: SlackOutboxEntry["body"]): string {
  const link =
    body.link_url !== undefined && isSafeLink(body.link_url)
      ? `\n\n<${body.link_url}|${SLACK_OUTBOX_MESSAGES.link}>`
      : "";
  const escaped = (value: string) =>
    escapeSlackControls(value, {
      maskedLinks: "expand",
      ...(body.mention_user_ids === undefined
        ? {}
        : { userIds: body.mention_user_ids }),
    });
  const text = escaped(body.text);
  const room = SLACK_TEXT_MAX - link.length - 1;
  if (text.length <= room + 1) return text + link;
  let piece = text;
  let cut = room;
  while (piece.length > room) {
    // Not inside an escape such as `&lt;`, nor between a surrogate pair.
    const amp = text.lastIndexOf("&", cut);
    if (amp !== -1 && amp > cut - 6 && !text.slice(amp, cut).includes(";")) {
      cut = amp;
    }
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    // A cut can open a code fence whose close fell away, and Slack shows an
    // unclosed fence as plain text: what it held must be escaped too.
    piece = escaped(text.slice(0, cut));
    cut -= piece.length - room;
  }
  return `${piece}…${link}`;
}

/** Refusal notices become ephemeral outbox rows, one per onceKey. */
export function createOutboxSlackNoticeSink(
  outbox: Pick<SlackOutboxStore, "enqueue">,
): SlackNoticeSink {
  return {
    async record(notice) {
      await outbox.enqueue({
        workspaceId: notice.workspaceId,
        agentId: notice.agentId,
        slackAppId: notice.slackAppId,
        installationId: notice.installationId,
        kind: "notice",
        channelId: notice.channelId,
        threadTs: notice.threadTs,
        slackUserId: notice.slackUserId,
        sessionId: null,
        body: notice.notice,
        dedupeKey: `notice:${notice.onceKey}`,
      });
    },
  };
}

function sessionUrl(consoleOrigin: string | null, sessionId: string) {
  return consoleOrigin === null
    ? undefined
    : new URL(`/sessions/${sessionId}`, consoleOrigin).toString();
}

/** Enqueues the reply, failure or input notice of turns that lack one. */
export async function enqueueSlackTurnAnswers(deps: {
  outbox: Pick<SlackOutboxStore, "unansweredTurns" | "enqueue">;
  consoleOrigin: string | null;
  limit: number;
}): Promise<number> {
  const turns = await deps.outbox.unansweredTurns(deps.limit);
  for (const turn of turns) {
    const link_url = sessionUrl(deps.consoleOrigin, turn.sessionId);
    const text =
      turn.state === "completed"
        ? finalReplyText(turn.events) || SLACK_OUTBOX_MESSAGES.emptyReply
        : turn.state === "failed"
          ? SLACK_NOTICE_MESSAGES.failed
          : SLACK_OUTBOX_MESSAGES.needsInput;
    await deps.outbox.enqueue({
      workspaceId: turn.workspaceId,
      agentId: turn.agentId,
      slackAppId: turn.slackAppId,
      installationId: turn.installationId,
      kind:
        turn.state === "completed"
          ? "reply"
          : turn.state === "failed"
            ? "failure_notice"
            : "input_notice",
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      slackUserId: null,
      sessionId: turn.sessionId,
      body: {
        text,
        ...(link_url === undefined ? {} : { link_url }),
        ...(turn.requesterSlackUserId === null
          ? {}
          : { mention_user_ids: [turn.requesterSlackUserId] }),
      },
      dedupeKey: slackTurnDedupeKey(
        turn.state,
        turn.sessionLinkId,
        turn.turnId,
      ),
    });
  }
  return turns.length;
}

export type SlackOutboxDrain = {
  enqueued: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  uncertain: number;
  lost: number;
};

function settleFor(
  claim: SlackOutboxClaim,
  response: SlackSendResponse,
): SlackOutboxSettle {
  // A 2xx or 5xx whose answer could not be read: Slack may hold the
  // message, so this is no failure to retry. A 4xx, 429 included, is
  // judged by its status and Retry-After alone.
  if (
    response.body === null &&
    ((response.httpStatus >= 200 && response.httpStatus < 300) ||
      response.httpStatus >= 500)
  ) {
    return { status: "uncertain", errorCode: "unreadable_answer" };
  }
  const outcome = classifySlackSendResult({
    httpStatus: response.httpStatus,
    retryAfterHeader: response.retryAfterHeader,
    body: response.body,
    attempts: claim.attempts,
  });
  switch (outcome.kind) {
    case "sent":
      return { status: "sent", slackTs: outcome.ts };
    case "failed":
      return { status: "failed", errorCode: outcome.code };
    case "retry_after":
      return claim.attempts >= SLACK_OUTBOX_MAX_ATTEMPTS
        ? { status: "failed", errorCode: "ratelimited" }
        : {
            status: "pending",
            errorCode: "ratelimited",
            retryInMs: Math.min(outcome.waitMs, SLACK_RETRY_AFTER_MAX_MS),
          };
    case "retry":
      return {
        status: "pending",
        errorCode: outcome.code,
        retryInMs: slackInboundBackoffMs(claim.attempts),
      };
  }
}

/**
 * One outbox pass of the `slack` role: rows whose send outlived its lease
 * become `uncertain` (a lost reply gets a notice saying so), unanswered
 * turns are enqueued, then due rows are sent until none is left or
 * `deadline` passes. A row is `sending` only while its request is in
 * flight, so nothing Slack may already hold is sent twice.
 */
export async function drainSlackOutbox(deps: {
  outbox: SlackOutboxStore;
  slack: Pick<SlackBotApi, "setStatus"> & SlackBotSender;
  /** Null without a master key: rows wait, unsent. */
  botToken:
    | ((workspaceId: string, slackAppId: string) => Promise<string | null>)
    | null;
  logger: SlackInboxLogger;
  consoleOrigin: string | null;
  batchSize: number;
  leaseMs: number;
  deadline: number;
  now?: () => number;
}): Promise<SlackOutboxDrain> {
  const now = deps.now ?? Date.now;
  const drain: SlackOutboxDrain = {
    enqueued: 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    uncertain: 0,
    lost: 0,
  };
  // A reply Slack may or may not hold: the thread hears so, once.
  const noticeUncertain = async (row: SlackOutboxLost) => {
    if (row.kind !== "reply" || row.sessionId === null) return;
    const link_url = sessionUrl(deps.consoleOrigin, row.sessionId);
    const text = SLACK_OUTBOX_MESSAGES.uncertain;
    await deps.outbox.enqueue({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      slackAppId: row.slackAppId,
      installationId: row.installationId,
      kind: "failure_notice",
      channelId: row.channelId,
      threadTs: row.threadTs,
      slackUserId: null,
      sessionId: row.sessionId,
      body: link_url === undefined ? { text } : { text, link_url },
      dedupeKey: `uncertain:${row.id}`,
    });
  };
  // The turn is over from the thread's side: clear "is thinking".
  const clearThreadStatus = async (
    botToken: string,
    row: Pick<SlackOutboxEntry, "channelId" | "threadTs">,
    ids: Record<string, unknown>,
  ) => {
    try {
      await deps.slack.setStatus(botToken, {
        channelId: row.channelId,
        threadTs: row.threadTs,
        status: "active",
      });
    } catch (error) {
      deps.logger.warn("Slack setStatus after the answer failed", {
        ...ids,
        error:
          error instanceof SlackApiError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  };
  // An instruction goes under its sender's name and profile image. An app
  // installed before chat:write.customize may be refused the name; Slack
  // posted nothing then, so it goes once more as the app.
  // Read before beginSend, so a slow users.info spends no send lease.
  const senderImage = (botToken: string, claim: SlackOutboxClaim) =>
    claim.kind !== "instruction" ||
    claim.body.sender?.slack_user_id === undefined
      ? Promise.resolve(null)
      : deps.slack
          .userImage(botToken, claim.body.sender.slack_user_id)
          .catch(() => null);
  const postMessage = async (
    botToken: string,
    claim: SlackOutboxClaim,
    text: string,
    iconUrl: string | null,
  ) => {
    const target = {
      channelId: claim.channelId,
      threadTs: claim.threadTs,
      text,
    };
    const sender = claim.body.sender;
    if (claim.kind !== "instruction" || sender === undefined) {
      return deps.slack.postMessage(botToken, target);
    }
    const response = await deps.slack.postMessage(botToken, {
      ...target,
      username: sender.username,
      ...(iconUrl === null ? {} : { iconUrl }),
    });
    const refused =
      typeof response.body === "object" &&
      response.body !== null &&
      (response.body as { error?: unknown }).error === "missing_scope";
    return refused ? deps.slack.postMessage(botToken, target) : response;
  };
  // A lost reply's notice clears the status once sent; a lost notice has
  // nothing after it to do so.
  const lostNotices: SlackOutboxLost[] = [];
  for (const lost of await deps.outbox.expireSending()) {
    drain.uncertain += 1;
    deps.logger.warn("Slack send outlived its lease; marked uncertain", {
      id: lost.id,
      kind: lost.kind,
      channel_id: lost.channelId,
    });
    if (lost.kind === "failure_notice") lostNotices.push(lost);
  }
  for (const closed of await deps.outbox.closeUnaddressed()) {
    drain.failed += 1;
    deps.logger.info("Slack send dropped; its thread no longer takes it", {
      id: closed.id,
      kind: closed.kind,
      channel_id: closed.channelId,
    });
  }
  // Also those a pass marked and died before telling, or told with a failed
  // enqueue: the notice is the dedupe key's, so it goes once.
  for (const row of await deps.outbox.untoldUncertain(deps.batchSize)) {
    await noticeUncertain(row);
  }
  await deps.outbox.advanceAnswered();
  // First, so an answer enqueued below is claimed after what it answers.
  drain.enqueued = await enqueueSlackInstructions({
    outbox: deps.outbox,
    limit: deps.batchSize,
  });
  drain.enqueued += await enqueueSlackTurnAnswers({
    outbox: deps.outbox,
    consoleOrigin: deps.consoleOrigin,
    limit: deps.batchSize,
  });
  if (deps.botToken === null) return drain;
  for (const lost of lostNotices) {
    const botToken = await deps
      .botToken(lost.workspaceId, lost.slackAppId)
      .catch(() => null);
    if (botToken !== null) {
      await clearThreadStatus(botToken, lost, { id: lost.id, kind: lost.kind });
    }
  }

  while (now() < deps.deadline) {
    const batch = await deps.outbox.claim({
      limit: deps.batchSize,
      leaseMs: deps.leaseMs,
    });
    if (batch.length === 0) break;
    for (const claim of batch) {
      drain.claimed += 1;
      const ids = {
        id: claim.id,
        kind: claim.kind,
        channel_id: claim.channelId,
        attempts: claim.attempts,
      };
      const settle = async (outcome: SlackOutboxSettle) => {
        if (!(await deps.outbox.settle(claim, outcome))) {
          drain.lost += 1;
          deps.logger.warn("Slack outbox lease lost", ids);
          return false;
        }
        drain[
          outcome.status === "pending"
            ? "retried"
            : outcome.status === "sent"
              ? "sent"
              : outcome.status
        ] += 1;
        if (outcome.status !== "sent") {
          deps.logger.warn("Slack send not delivered", {
            ...ids,
            status: outcome.status,
            error: outcome.errorCode,
          });
        }
        return true;
      };

      let botToken: string | null;
      try {
        botToken = await deps.botToken(claim.workspaceId, claim.slackAppId);
      } catch {
        botToken = null;
      }
      if (botToken === null) {
        await settle(
          claim.attempts >= SLACK_SEND_MAX_ATTEMPTS
            ? { status: "failed", errorCode: "no_bot_token" }
            : {
                status: "pending",
                errorCode: "no_bot_token",
                retryInMs: slackInboundBackoffMs(claim.attempts),
              },
        );
        continue;
      }
      const iconUrl = await senderImage(botToken, claim);
      if (!(await deps.outbox.beginSend(claim))) {
        drain.lost += 1;
        deps.logger.warn("Slack outbox lease lost before send", ids);
        continue;
      }

      const text = slackOutboxText(claim.body);
      let outcome: SlackOutboxSettle;
      try {
        const response =
          claim.kind === "notice" && claim.slackUserId !== null
            ? await deps.slack.postEphemeral(botToken, {
                channelId: claim.channelId,
                userId: claim.slackUserId,
                threadTs: claim.threadTs,
                text,
              })
            : await postMessage(botToken, claim, text, iconUrl);
        outcome = settleFor(claim, response);
      } catch (error) {
        // No answer came: the request may have reached Slack.
        outcome = {
          status: "uncertain",
          errorCode: error instanceof SlackApiError ? error.code : "send_threw",
        };
      }
      const settled = await settle(outcome);
      if (settled && outcome.status === "uncertain") {
        await noticeUncertain(claim);
      }
      if (
        settled &&
        outcome.status !== "pending" &&
        claim.kind !== "notice" &&
        claim.kind !== "instruction" &&
        claim.kind !== "input_notice" &&
        claim.kind !== "welcome"
      ) {
        await clearThreadStatus(botToken, claim, ids);
      }
    }
  }
  return drain;
}

import {
  DEFAULT_USER_LOCALE,
  type PendingQuestion,
  type PushDecision,
  type QuestionAnswer,
  SLACK_INTERACTION_ACTIONS,
  SLACK_NOTICE_MESSAGES,
  SLACK_QUESTION_VIEW_CALLBACK,
  type SlackBlockActionsPayload,
  type SlackInteractionResponse,
  type SlackInteractionValue,
  type SlackNoticeMessage,
  type SlackQuestionViewMetadata,
  type SlackViewSubmissionPayload,
  slackBlockActionsPayloadSchema,
  slackInteractionPayloadSchema,
  slackInteractionValueSchema,
  slackQuestionViewMetadataSchema,
  slackViewSubmissionPayloadSchema,
  type UserLocale,
} from "@werft-ai/contracts";
import type { AgentIdentityStore } from "../ports/agent-identity-store.ts";
import type { LinkedAccountStore } from "../ports/linked-account-store.ts";
import type { SlackOutboxStore } from "../ports/slack-outbox-store.ts";
import type { SurfaceBindingStore } from "../ports/surface-binding-store.ts";
import type { PendingRequestService } from "../sessions/pending-service.ts";
import type {
  PushActor,
  PushRequestService,
} from "../sessions/push-request-service.ts";
import {
  type SessionService,
  SessionServiceError,
} from "../sessions/session-service.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import type { SlackBotApi, SlackBotSender } from "./slack-config-api.ts";
import {
  authorizeSlackInput,
  type SlackDecision,
  slackCallerOf,
} from "./slack-decision.ts";
import {
  type SlackSigningSecrets,
  verifySlackSignature,
} from "./slack-events-service.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";
import { slackOutboxText } from "./slack-outbox.ts";
import {
  SLACK_PROMPT_MESSAGES,
  type SlackPromptResult,
  slackOptionAnswer,
  slackPromptMessage,
  slackQuestionAnswers,
  slackQuestionView,
  slackSettledBlocks,
} from "./slack-prompts.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the session reads once a push it asked for is decided in Slack.
 */
export function slackPushFollowUp(
  decision: PushDecision,
  push: { id: string; repositoryId: string; targetBranch: string },
): string {
  return decision === "approve"
    ? `Platform note: a person approved push request ${push.id} (repository ${push.repositoryId}, branch ${push.targetBranch}) in Slack. The push runs in the background: call open_pull_request now, and if it answers not_pushed, wait a few seconds and call it again. Then finish what you were asked to do.`
    : `Platform note: a person rejected push request ${push.id} (repository ${push.repositoryId}, branch ${push.targetBranch}) in Slack, so nothing was pushed. Do not ask to push it again unless you are asked to. Say in one short reply that the push was rejected.`;
}

export type SlackInteractionOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_request" }
  | { kind: "ok"; body: SlackInteractionResponse; result: string };

export type SlackInteractionDeps = {
  signingSecrets: Pick<SlackSigningSecrets, "forAgent">;
  authorization: AuthorizationPolicy;
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  links: Pick<LinkedAccountStore, "resolveLinkedSubject">;
  bindings: Pick<SurfaceBindingStore, "resolveSlackChannel">;
  pending: Pick<
    PendingRequestService,
    "answer" | "listPendingRequests" | "outcome"
  >;
  pushes: Pick<PushRequestService, "decide" | "get">;
  sessions: Pick<SessionService, "appendMessage">;
  slack: Pick<SlackBotApi, "userInfo"> &
    Required<Pick<SlackBotApi, "updateMessage" | "openView">> &
    Pick<SlackBotSender, "postEphemeral">;
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  outbox: Pick<SlackOutboxStore, "readerLocale">;
  /** The web page where a person links their Slack account. */
  connectUrl: string;
  logger: SlackInboxLogger;
  now?: () => Date;
  newRequestId?: () => string;
};

const OK: SlackInteractionResponse = { ok: true };
const CLEAR: SlackInteractionResponse = { response_action: "clear" };

const REQUEST_GONE_CODES = new Set([
  "REQUEST_EXPIRED",
  "REQUEST_STALE",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "PUSH_REQUEST_RESOLVED",
]);

type Pressed = {
  agentId: string;
  workspaceId: string;
  slackAppId: string;
  appId: string;
  teamId: string;
  userId: string;
  channelId: string;
  threadTs: string;
  botToken: string;
  locale: UserLocale;
};

type Allowed = { caller: Caller; pressed: Pressed };

export type SlackInteractionService = ReturnType<
  typeof createSlackInteractionService
>;

/**
 * Slack's interactivity request URL for one agent's app: the buttons and
 * the modal of the cards the outbox posts for requests a session waits on.
 * Signed like events; every press is judged as `session.approve` for the
 * person who pressed it, the same decision the web makes.
 */
export function createSlackInteractionService(deps: SlackInteractionDeps) {
  const now = deps.now ?? (() => new Date());
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());

  const ok = (result: string, body = OK): SlackInteractionOutcome => ({
    kind: "ok",
    body,
    result,
  });

  async function tell(pressed: Pressed, text: string, linkUrl?: string) {
    try {
      await deps.slack.postEphemeral(pressed.botToken, {
        channelId: pressed.channelId,
        userId: pressed.userId,
        threadTs: pressed.threadTs,
        text: slackOutboxText({
          text,
          locale: pressed.locale,
          ...(linkUrl === undefined ? {} : { link_url: linkUrl }),
        }),
      });
    } catch (error) {
      deps.logger.warn("Slack ephemeral for a press failed", {
        agent_id: pressed.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const notice = (pressed: Pressed, message: SlackNoticeMessage) =>
    tell(pressed, SLACK_NOTICE_MESSAGES[pressed.locale][message]);

  async function settle(
    pressed: Pressed,
    ts: string,
    asked: unknown[],
    result: SlackPromptResult,
    by: string | null,
  ) {
    const card = slackSettledBlocks(asked, result, {
      locale: pressed.locale,
      slackUserId: by,
    });
    try {
      await deps.slack.updateMessage(pressed.botToken, {
        channelId: pressed.channelId,
        ts,
        ...card,
      });
    } catch (error) {
      deps.logger.warn("Slack card update failed", {
        agent_id: pressed.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function admit(
    agentId: string,
    app: { workspaceId: string; slackAppId: string; appId: string },
    input: {
      teamId: string;
      userId: string;
      channelId: string;
      threadTs: string;
      sessionId: string;
    },
  ): Promise<Allowed | { refused: string }> {
    const botToken = await deps.botToken(app.workspaceId, app.slackAppId);
    if (botToken === null) return { refused: "no_bot_token" };
    const locale =
      (await deps.outbox.readerLocale({
        workspaceId: app.workspaceId,
        teamId: input.teamId,
        slackUserId: input.userId,
      })) ?? DEFAULT_USER_LOCALE;
    const pressed: Pressed = {
      agentId,
      ...app,
      teamId: input.teamId,
      userId: input.userId,
      channelId: input.channelId,
      threadTs: input.threadTs,
      botToken,
      locale,
    };
    const user = await deps.slack.userInfo(botToken, input.userId);
    const requestId = newRequestId();
    const decision: SlackDecision = await authorizeSlackInput(deps, {
      event: { appId: app.appId, teamId: input.teamId, agentId },
      user,
      action: "session.approve",
      channel: { id: input.channelId, dm: input.channelId.startsWith("D") },
      resource: { kind: "session", id: input.sessionId },
      requestId,
      connectUrl: deps.connectUrl,
    });
    if (decision.status === "dropped") return { refused: decision.reason };
    if (decision.decision.outcome !== "allow") {
      if (decision.notice !== null) {
        await tell(
          pressed,
          SLACK_NOTICE_MESSAGES[locale][decision.notice.message],
          decision.notice.link_url,
        );
      }
      return { refused: decision.decision.reason_code };
    }
    return { caller: slackCallerOf(decision, requestId), pressed };
  }

  async function pendingQuestions(
    caller: Caller,
    value: SlackInteractionValue,
  ): Promise<PendingQuestion[] | null> {
    const listed = await deps.pending.listPendingRequests(caller, value.s);
    const request = listed.items.find(
      (item) => item.request_id === value.r && item.kind === "question",
    );
    return request?.kind === "question" ? request.questions : null;
  }

  async function standing(
    caller: Caller,
    value: SlackInteractionValue,
  ): Promise<SlackPromptResult | "open"> {
    const outcome = await deps.pending.outcome(caller, value.s, value.r);
    if (outcome === null) return "closed";
    if (outcome.state !== "answered") return outcome.state;
    if (outcome.kind === "question") return "answered";
    return outcome.decision === "allow" ? "allowed" : "denied";
  }

  async function answer(
    { caller, pressed }: Allowed,
    value: SlackInteractionValue,
    body:
      | { kind: "permission"; decision: "allow" | "deny" }
      | { kind: "question"; answers: QuestionAnswer[] },
    card: (result: SlackPromptResult, by: string | null) => Promise<void>,
  ): Promise<string> {
    try {
      await deps.pending.answer(caller, value.s, {
        idempotencyKey: `slack:${value.r}`,
        body: { request_id: value.r, ...body },
      });
    } catch (error) {
      if (!(error instanceof SessionServiceError)) throw error;
      if (error.code === "FORBIDDEN") {
        await notice(pressed, "noApproveRight");
        return "refused";
      }
      const now = REQUEST_GONE_CODES.has(error.code)
        ? await standing(caller, value)
        : "open";
      if (now === "open") {
        deps.logger.warn("Slack answer not taken", {
          agent_id: pressed.agentId,
          code: error.code,
        });
        await notice(pressed, "failed");
        return "failed";
      }
      await card(now, null);
      return "already";
    }
    await card(
      body.kind === "question"
        ? "answered"
        : body.decision === "allow"
          ? "allowed"
          : "denied",
      pressed.userId,
    );
    return "answered";
  }

  async function decidePush(
    { caller, pressed }: Allowed,
    value: SlackInteractionValue,
    decision: PushDecision,
    card: (result: SlackPromptResult, by: string | null) => Promise<void>,
  ): Promise<string> {
    if (caller.subject.principal === null) return "refused";
    const actor: PushActor = {
      caller,
      principal: caller.subject.principal,
      ownerId: caller.ownerId,
      verified: true,
    };
    const stateOf = async (): Promise<SlackPromptResult | "open"> => {
      const request = await deps.pushes
        .get(actor, value.s, value.r)
        .catch(() => null);
      if (request === null) return "closed";
      if (request.state === "requested") return "open";
      return request.state === "rejected" ? "rejected" : "approved";
    };
    const request = await deps.pushes
      .get(actor, value.s, value.r)
      .catch(() => null);
    if (request === null || request.state !== "requested") {
      await card(
        request === null
          ? "closed"
          : request.state === "rejected"
            ? "rejected"
            : "approved",
        null,
      );
      return "already";
    }
    try {
      await deps.pushes.decide(actor, value.s, value.r, {
        idempotencyKey: `slack:${value.r}`,
        readBody: async () => ({ decision, git_commit: request.git_commit }),
      });
    } catch (error) {
      if (!(error instanceof SessionServiceError)) throw error;
      const now = await stateOf();
      if (now !== "open") {
        await card(now, null);
        return "already";
      }
      const refusal = (error.details as { refusal?: unknown } | undefined)
        ?.refusal;
      deps.logger.warn("Slack push decision not taken", {
        agent_id: pressed.agentId,
        code: error.code,
        refusal: typeof refusal === "string" ? refusal : null,
      });
      await notice(
        pressed,
        error.code === "FORBIDDEN" ? "noApproveRight" : "failed",
      );
      return "failed";
    }
    await card(
      decision === "approve" ? "approved" : "rejected",
      pressed.userId,
    );
    try {
      await deps.sessions.appendMessage(caller, value.s, {
        idempotencyKey: `slack-push:${value.r}`,
        body: {
          message: slackPushFollowUp(decision, {
            id: request.id,
            repositoryId: request.repository_id,
            targetBranch: request.target_branch,
          }),
          mode: "enqueue",
        },
      });
    } catch (error) {
      deps.logger.warn("Slack push follow-up turn not queued", {
        agent_id: pressed.agentId,
        code:
          error instanceof SessionServiceError
            ? error.code
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
    return decision === "approve" ? "approved" : "rejected";
  }

  async function onAction(
    agentId: string,
    app: { workspaceId: string; slackAppId: string; appId: string },
    payload: SlackBlockActionsPayload,
  ): Promise<SlackInteractionOutcome> {
    const [action] = payload.actions;
    if (action === undefined) return ok("ignored");
    let value: SlackInteractionValue;
    try {
      value = slackInteractionValueSchema.parse(JSON.parse(action.value ?? ""));
    } catch {
      return ok("ignored");
    }
    const threadTs = payload.message.thread_ts ?? payload.message.ts;
    const admitted = await admit(agentId, app, {
      teamId: payload.team.id,
      userId: payload.user.id,
      channelId: payload.channel.id,
      threadTs,
      sessionId: value.s,
    });
    if ("refused" in admitted) return ok(`refused:${admitted.refused}`);
    const asked = Array.isArray(payload.message.blocks)
      ? (payload.message.blocks as unknown[])
      : [];
    const card = (result: SlackPromptResult, by: string | null) =>
      settle(admitted.pressed, payload.message.ts, asked, result, by);

    switch (action.action_id) {
      case SLACK_INTERACTION_ACTIONS.permissionAllow:
      case SLACK_INTERACTION_ACTIONS.permissionDeny:
        return ok(
          await answer(
            admitted,
            value,
            {
              kind: "permission",
              decision:
                action.action_id === SLACK_INTERACTION_ACTIONS.permissionAllow
                  ? "allow"
                  : "deny",
            },
            card,
          ),
        );
      case SLACK_INTERACTION_ACTIONS.questionOption: {
        const questions = await pendingQuestions(admitted.caller, value);
        const answers =
          questions === null ? null : slackOptionAnswer(questions, value.o);
        if (answers === null) {
          const now = await standing(admitted.caller, value);
          if (now === "open") {
            await notice(admitted.pressed, "failed");
            return ok("failed");
          }
          await card(now, null);
          return ok("already");
        }
        return ok(
          await answer(admitted, value, { kind: "question", answers }, card),
        );
      }
      case SLACK_INTERACTION_ACTIONS.questionOpen: {
        const questions = await pendingQuestions(admitted.caller, value);
        if (questions === null) {
          const now = await standing(admitted.caller, value);
          await card(now === "open" ? "closed" : now, null);
          return ok("already");
        }
        const metadata: SlackQuestionViewMetadata = {
          s: value.s,
          r: value.r,
          c: payload.channel.id,
          m: payload.message.ts,
          t: threadTs,
        };
        const view = slackQuestionView(
          questions,
          metadata,
          admitted.pressed.locale,
        );
        if (view === null) {
          await notice(admitted.pressed, "failed");
          return ok("failed");
        }
        await deps.slack.openView(admitted.pressed.botToken, {
          triggerId: payload.trigger_id,
          view,
        });
        return ok("view_opened");
      }
      case SLACK_INTERACTION_ACTIONS.pushApprove:
      case SLACK_INTERACTION_ACTIONS.pushReject:
        return ok(
          await decidePush(
            admitted,
            value,
            action.action_id === SLACK_INTERACTION_ACTIONS.pushApprove
              ? "approve"
              : "reject",
            card,
          ),
        );
      default:
        return ok("ignored");
    }
  }

  async function onSubmit(
    agentId: string,
    app: { workspaceId: string; slackAppId: string; appId: string },
    payload: SlackViewSubmissionPayload,
  ): Promise<SlackInteractionOutcome> {
    if (payload.view.callback_id !== SLACK_QUESTION_VIEW_CALLBACK) {
      return ok("ignored", CLEAR);
    }
    let metadata: SlackQuestionViewMetadata;
    try {
      metadata = slackQuestionViewMetadataSchema.parse(
        JSON.parse(payload.view.private_metadata),
      );
    } catch {
      return ok("ignored", CLEAR);
    }
    const value: SlackInteractionValue = { s: metadata.s, r: metadata.r };
    const admitted = await admit(agentId, app, {
      teamId: payload.team.id,
      userId: payload.user.id,
      channelId: metadata.c,
      threadTs: metadata.t,
      sessionId: metadata.s,
    });
    if ("refused" in admitted) return ok(`refused:${admitted.refused}`, CLEAR);
    const { pressed } = admitted;
    const questions = await pendingQuestions(admitted.caller, value);
    if (questions === null) {
      const now = await standing(admitted.caller, value);
      await tell(
        pressed,
        SLACK_PROMPT_MESSAGES[pressed.locale].already[
          now === "open" ? "closed" : now
        ],
      );
      return ok("already", CLEAR);
    }
    const parsed = slackQuestionAnswers(
      questions,
      payload.view.state.values,
      pressed.locale,
    );
    if (!parsed.ok) {
      return ok("invalid", {
        response_action: "errors",
        errors: parsed.errors,
      });
    }
    // The card as it was asked, rebuilt: a modal carries no message.
    const asked = slackPromptMessage(
      {
        kind: "question",
        sessionId: value.s,
        requestId: value.r,
        questions,
        expiresAt: now().toISOString(),
      },
      { locale: pressed.locale, requesterSlackUserId: null },
    ).blocks;
    const result = await answer(
      admitted,
      value,
      { kind: "question", answers: parsed.answers },
      (outcome, by) => settle(pressed, metadata.m, asked, outcome, by),
    );
    return ok(result, CLEAR);
  }

  return {
    async receive(request: {
      agentId: string;
      rawBody: Uint8Array;
      timestamp: string | null;
      signature: string | null;
    }): Promise<SlackInteractionOutcome> {
      if (!UUID.test(request.agentId)) return { kind: "unauthorized" };
      const agentId = request.agentId.toLowerCase();
      const app = await deps.signingSecrets.forAgent(agentId);
      if (app === null) return { kind: "unauthorized" };
      const check = verifySlackSignature({
        signingSecret: app.signingSecret,
        timestamp: request.timestamp,
        signature: request.signature,
        rawBody: request.rawBody,
        nowSeconds: Math.floor(now().getTime() / 1000),
      });
      if (check !== "ok") return { kind: "unauthorized" };

      let body: unknown;
      try {
        const form = new URLSearchParams(
          new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody),
        );
        body = JSON.parse(form.get("payload") ?? "");
      } catch {
        return { kind: "bad_request" };
      }
      const parsed = slackInteractionPayloadSchema.safeParse(body);
      if (!parsed.success) return { kind: "bad_request" };
      const target = {
        workspaceId: app.workspaceId,
        slackAppId: app.slackAppId,
        appId: app.appId,
      };
      const actions = slackBlockActionsPayloadSchema.safeParse(parsed.data);
      if (actions.success) {
        if (actions.data.api_app_id !== app.appId) return ok("app_mismatch");
        return onAction(agentId, target, actions.data);
      }
      const submit = slackViewSubmissionPayloadSchema.safeParse(parsed.data);
      if (submit.success) {
        if (submit.data.api_app_id !== app.appId) {
          return ok("app_mismatch", CLEAR);
        }
        return onSubmit(agentId, target, submit.data);
      }
      if (
        parsed.data.type === "block_actions" ||
        parsed.data.type === "view_submission"
      ) {
        return { kind: "bad_request" };
      }
      return ok("ignored");
    },
  };
}

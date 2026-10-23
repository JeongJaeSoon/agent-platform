import {
  SLACK_EVENTS_BODY_MAX_BYTES,
  slackEventsResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackEventsService } from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  ingestThenStopClockWithin,
  jsonWithSchema,
} from "../app.ts";
import type { SlackEventsLimiter } from "../rate-limit.ts";

// One answer for every request that is not provably from the agent's app:
// unknown agent, no app, no secret, bad or stale signature.
const REFUSED = "Request signature is not valid";

const retryNumOf = (header: string | undefined) =>
  header !== undefined && /^\d{1,4}$/.test(header) ? Number(header) : null;

/**
 * Slack's events for one agent's app (public: Slack signs, nobody logs in).
 * The limiter runs before the body is read and before any database read;
 * the body bound is Slack's, not the API's. Logged: ids, outcome and drop
 * reason only, never the body, the text or a header value.
 */
export function registerSlackEventRoutes(
  router: ApiRouter,
  deps: {
    events: SlackEventsService;
    limiter: SlackEventsLimiter;
    logger?: StructuredLogger;
  },
) {
  const { events, limiter, logger } = deps;

  apiRoute(
    router,
    "receiveSlackEvent",
    async (context, next) => {
      const retryAfter = limiter.admit(context.req.param("agent_id") ?? "");
      if (retryAfter !== null) {
        throw new ApiHttpError(
          429,
          "RATE_LIMITED",
          "Too many Slack events, try again later",
          true,
          retryAfter,
        );
      }
      return ingestThenStopClockWithin(SLACK_EVENTS_BODY_MAX_BYTES)(
        context,
        next,
      );
    },
    async (context) => {
      const agentId = context.req.param("agent_id") ?? "";
      const outcome = await events.receive({
        agentId,
        rawBody: new Uint8Array(await context.req.arrayBuffer()),
        timestamp: context.req.header("X-Slack-Request-Timestamp") ?? null,
        signature: context.req.header("X-Slack-Signature") ?? null,
      });
      switch (outcome.kind) {
        case "unauthorized":
          logger?.warn("Slack event refused", { agent_id: agentId });
          throw new ApiHttpError(401, "UNAUTHORIZED", REFUSED);
        case "bad_request":
          throw new ApiHttpError(400, "BAD_REQUEST", "Not a Slack event");
        case "challenge":
          return jsonWithSchema(context, slackEventsResponseSchema, {
            challenge: outcome.challenge,
          });
        case "ack":
          logger?.info("Slack event received", {
            agent_id: agentId,
            team_id: outcome.teamId ?? null,
            event_id: outcome.eventId ?? null,
            result: outcome.result,
            status: outcome.status ?? null,
            drop_reason: outcome.reason ?? null,
            retry_num: retryNumOf(context.req.header("X-Slack-Retry-Num")),
          });
          return jsonWithSchema(context, slackEventsResponseSchema, {
            ok: true,
          });
      }
    },
  );
}

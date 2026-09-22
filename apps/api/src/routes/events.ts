import {
  lastEventIdHeadersSchema,
  type SseEvent,
  sessionIdParamsSchema,
} from "@agent-platform/contracts";
import {
  createLogger,
  type StructuredLogger,
} from "@agent-platform/observability";
import type { SessionService } from "@agent-platform/platform";
import { streamSSE } from "hono/streaming";
import { ApiHttpError, type ApiRouter } from "../app.ts";
import type { SessionEventWakeup } from "../events/notifications.ts";
import { mapped, requireParams } from "./sessions.ts";

// api.md § 이벤트: 15 s keepalive, and a revoked key ends the stream within
// the same window.
export const SSE_KEEPALIVE_MS = 15_000;
// Rows held in memory per connection between writes; also the page size, so
// a full page means "read again", a short one means "wait for more".
export const SSE_REPLAY_BATCH = 100;

// 410 CURSOR_EXPIRED is declared for clients and reserved here; alpha never
// trims events, so nothing produces it yet.
export const eventRouteErrors: Record<string, number[]> = {
  "GET /v1/sessions/{id}/events": [400, 401, 404, 410, 503],
};

export interface EventStreamOptions {
  wakeup: SessionEventWakeup;
  keepaliveMs?: number;
  batchSize?: number;
  logger?: Pick<StructuredLogger, "info" | "warn">;
}

export interface EventStreamHandle {
  activeStreams(): number;
}

function sleep(ms: number, signal: AbortSignal): Promise<"tick" | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("tick");
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function requireLastEventId(
  headerValue: string | undefined,
): string | undefined {
  // An empty header is what a client sends after seeing no id yet; treat it
  // as absent rather than as a malformed cursor.
  const parsed = lastEventIdHeadersSchema.safeParse({
    "last-event-id": headerValue || undefined,
  });
  if (!parsed.success) {
    throw new ApiHttpError(400, "BAD_REQUEST", "Last-Event-ID is invalid");
  }
  return parsed.data["last-event-id"];
}

export function registerEventRoutes(
  router: ApiRouter,
  service: SessionService,
  options: EventStreamOptions,
): EventStreamHandle {
  const keepaliveMs = options.keepaliveMs ?? SSE_KEEPALIVE_MS;
  const batchSize = options.batchSize ?? SSE_REPLAY_BATCH;
  const logger = options.logger ?? createLogger();
  let active = 0;

  router.get("/sessions/:id/events", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const actor = { ownerId: context.get("ownerId") };
    const reauthenticate = context.get("reauthenticate");
    const after = requireLastEventId(context.req.header("Last-Event-ID"));
    const read = (cursor: string | undefined) =>
      mapped(() =>
        service.readEvents(actor, params.id, {
          ...(cursor === undefined ? {} : { after: cursor }),
          limit: batchSize,
        }),
      );
    // A waiter is armed before every read, this first one included, so a
    // NOTIFY that lands between the read and the decision to wait is not
    // lost; the notifier only wakes waiters that exist when it fires.
    const armWait = (closed: AbortSignal) => {
      const wake = new AbortController();
      const unlink = () => wake.abort();
      closed.addEventListener("abort", unlink, { once: true });
      return {
        signal: wake.signal,
        notified: options.wakeup.wait(params.id, wake.signal),
        release() {
          closed.removeEventListener("abort", unlink);
          wake.abort();
        },
      };
    };
    const closed = new AbortController();
    let armed = armWait(closed.signal);
    // The first page is read before the response commits to a stream, so an
    // unknown session, a foreign owner, a bad cursor and a storage outage are
    // still ordinary HTTP errors with the API envelope.
    let firstPage: SseEvent[];
    try {
      firstPage = await read(after);
    } catch (error) {
      armed.release();
      throw error;
    }

    // Reverse proxies buffer responses by default; nginx honours this header
    // and the Cache-Control that streamSSE sets.
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      const closeWith = (reason: string) => {
        if (!closed.signal.aborted) closed.abort(reason);
      };
      stream.onAbort(() => closeWith("client_disconnected"));
      context.req.raw.signal.addEventListener(
        "abort",
        () => closeWith("client_disconnected"),
        { once: true },
      );

      active += 1;
      let sent = 0;
      let cursor = after;
      let lastAuthAt = Date.now();
      // On the keepalive clock whatever the stream is doing, so neither a
      // long replay nor a steady run of notifications lets a revoked key
      // keep reading past the window.
      const stillAuthenticated = async () => {
        if (Date.now() - lastAuthAt < keepaliveMs) return true;
        lastAuthAt = Date.now();
        return reauthenticate();
      };
      logger.info("SSE stream opened", {
        session_id: params.id,
        after: after ?? null,
        active_streams: active,
      });
      try {
        let page: SseEvent[] = firstPage;
        while (!closed.signal.aborted) {
          for (const event of page) {
            if (closed.signal.aborted) break;
            await stream.writeSSE({
              id: event.id,
              event: event.event,
              data: JSON.stringify(event.data),
            });
            cursor = event.id;
            sent += 1;
          }
          if (closed.signal.aborted) break;
          if (!(await stillAuthenticated())) {
            closeWith("credential_revoked");
            break;
          }
          // A short page means the high-watermark is reached: wait for a
          // NOTIFY, bounded by the keepalive so a lost notification costs at
          // most one interval. A full page means keep replaying; the
          // high-watermark is simply the last id sent.
          if (page.length < batchSize) {
            const outcome = await Promise.race([
              armed.notified.then(() => "notify" as const),
              sleep(keepaliveMs, armed.signal),
            ]);
            if (closed.signal.aborted) break;
            if (outcome === "tick") {
              await stream.write(": keepalive\n\n");
              if (!(await stillAuthenticated())) {
                closeWith("credential_revoked");
                break;
              }
            }
          }
          armed.release();
          armed = armWait(closed.signal);
          page = await read(cursor);
        }
      } catch (error) {
        // Headers are gone, so there is no error envelope to send; the client
        // reconnects with the last id it saw and the read is repeated then.
        logger.warn("SSE stream failed", {
          session_id: params.id,
          error_name: error instanceof Error ? error.name : "UnknownError",
        });
        closeWith("read_failed");
      } finally {
        armed.release();
        active -= 1;
        logger.info("SSE stream closed", {
          session_id: params.id,
          reason: closed.signal.aborted ? String(closed.signal.reason) : "eof",
          events_sent: sent,
          active_streams: active,
        });
      }
    });
  });

  return { activeStreams: () => active };
}

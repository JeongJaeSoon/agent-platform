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

// Admission caps: a stream is a resident handle plus a query every
// keepalive, so a runaway client must not be able to open them without
// bound. Sized for the alpha's single API process; raise via server env.
export const SSE_MAX_STREAMS = 256;
export const SSE_MAX_STREAMS_PER_OWNER = 8;

// 410 CURSOR_EXPIRED is declared for clients and reserved here; alpha never
// trims events, so nothing produces it yet.
export const eventRouteErrors: Record<string, number[]> = {
  "GET /v1/sessions/{id}/events": [400, 401, 404, 410, 429, 503],
};

export interface EventStreamOptions {
  wakeup: SessionEventWakeup;
  keepaliveMs?: number;
  batchSize?: number;
  maxStreams?: number;
  maxStreamsPerOwner?: number;
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
  const maxStreams = options.maxStreams ?? SSE_MAX_STREAMS;
  const maxStreamsPerOwner =
    options.maxStreamsPerOwner ?? SSE_MAX_STREAMS_PER_OWNER;
  const logger = options.logger ?? createLogger();
  let active = 0;
  const activeByOwner = new Map<string, number>();

  // Reserved before any database work so an over-limit client costs nothing
  // but this check; released when the stream ends or the request fails.
  const admit = (ownerId: string): (() => void) => {
    const mine = activeByOwner.get(ownerId) ?? 0;
    if (active >= maxStreams || mine >= maxStreamsPerOwner) {
      throw new ApiHttpError(
        429,
        "RATE_LIMITED",
        "Too many open event streams",
        true,
      );
    }
    active += 1;
    activeByOwner.set(ownerId, mine + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      const rest = (activeByOwner.get(ownerId) ?? 1) - 1;
      if (rest <= 0) activeByOwner.delete(ownerId);
      else activeByOwner.set(ownerId, rest);
    };
  };

  router.get("/sessions/:id/events", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const actor = { ownerId: context.get("ownerId") };
    const reauthenticate = context.get("reauthenticate");
    const after = requireLastEventId(context.req.header("Last-Event-ID"));
    let release: () => void;
    try {
      release = admit(actor.ownerId);
    } catch (error) {
      // Seconds: the earliest a slot can plausibly free up.
      context.header("Retry-After", String(Math.ceil(keepaliveMs / 1000)));
      throw error;
    }
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
    const closeWith = (reason: string) => {
      if (!closed.signal.aborted) closed.abort(reason);
    };
    // Credential watchdog, independent of whatever the loop is awaiting: a
    // read can span several pool timeouts and a write can sit on
    // backpressure, and neither may stretch the revocation window. Every
    // keepalive it re-runs the middleware's check; a "no", or a check that
    // does not answer within another keepalive, ends the stream. The clock
    // starts at the middleware's own check, before the first read.
    let onRevoked: (() => void) | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = () => {
      watchdog = setTimeout(async () => {
        let verdict: boolean;
        try {
          verdict = await Promise.race([
            reauthenticate(),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), keepaliveMs),
            ),
          ]);
        } catch {
          verdict = false;
        }
        if (closed.signal.aborted) return;
        if (!verdict) {
          closeWith("credential_revoked");
          onRevoked?.();
          return;
        }
        armWatchdog();
      }, keepaliveMs);
    };
    const disarmWatchdog = () => clearTimeout(watchdog);
    armWatchdog();

    let armed = armWait(closed.signal);
    // The first page is read before the response commits to a stream, so an
    // unknown session, a foreign owner, a bad cursor and a storage outage are
    // still ordinary HTTP errors with the API envelope.
    let firstPage: SseEvent[];
    try {
      firstPage = await read(after);
      if (closed.signal.aborted) {
        throw new ApiHttpError(
          401,
          "UNAUTHORIZED",
          "Authentication is required",
        );
      }
    } catch (error) {
      armed.release();
      disarmWatchdog();
      release();
      throw error;
    }

    // Reverse proxies buffer responses by default; nginx honours this header
    // and the Cache-Control that streamSSE sets.
    context.header("X-Accel-Buffering", "no");
    return streamSSE(context, async (stream) => {
      // Abort the body too: a write blocked on backpressure or a read still
      // in flight would otherwise keep the connection open past the verdict.
      onRevoked = () => stream.abort();
      stream.onAbort(() => closeWith("client_disconnected"));
      context.req.raw.signal.addEventListener(
        "abort",
        () => closeWith("client_disconnected"),
        { once: true },
      );

      let sent = 0;
      let cursor = after;
      // A write blocks on client backpressure. Past one keepalive the
      // connection is treated as dead: the body is aborted so the pending
      // write fails instead of holding the credential check hostage. The
      // timer is cleared when the write wins, so a fast replay does not
      // leave one pending timer per frame.
      const writeBounded = async (write: () => Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stalled = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), keepaliveMs);
        });
        try {
          return await Promise.race([write().then(() => true), stalled]);
        } finally {
          clearTimeout(timer);
        }
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
            const written = await writeBounded(() =>
              stream.writeSSE({
                id: event.id,
                event: event.event,
                data: JSON.stringify(event.data),
              }),
            );
            if (!written) {
              closeWith("write_stalled");
              stream.abort();
              break;
            }
            cursor = event.id;
            sent += 1;
          }
          if (closed.signal.aborted) break;
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
              if (
                !(await writeBounded(() => stream.write(": keepalive\n\n")))
              ) {
                closeWith("write_stalled");
                stream.abort();
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
        disarmWatchdog();
        release();
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

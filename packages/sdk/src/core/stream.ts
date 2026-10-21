import {
  type ApiClient,
  type ApiError,
  type SessionEventFrame,
  subscribeSessionEvents,
} from "@werft-ai/client";
import type { EventCursor, SessionEvent } from "../types.ts";
import { APIError } from "./errors.ts";

export interface StreamOptions {
  /** Resume strictly after this cursor; without it the whole session replays. */
  lastEventId?: string;
  signal?: AbortSignal;
}

/**
 * Never ends on its own, not even when the turn or the session does. It
 * ends on `signal` or close(), and throws on an error it does not recover
 * from (400, 401, 403, 404, 410). Reconnects resume with Last-Event-ID.
 */
export interface EventStream extends AsyncIterable<SessionEvent> {
  /** The cursor of the last event delivered; store it to resume elsewhere. */
  readonly lastEventId: EventCursor | undefined;
  close(): void;
}

function toEvent(frame: SessionEventFrame): SessionEvent {
  return {
    id: frame.id,
    turn_id: frame.turnId,
    attempt_id: frame.attemptId,
    occurred_at: frame.occurredAt,
    kind: frame.payload.event,
    payload: frame.payload.data,
  } as SessionEvent;
}

function fromClientError(error: ApiError): APIError {
  return new APIError(error.status, error.code, error.message, {
    retryable: error.retryable === true,
    requestId: error.requestId,
    details: error.details,
    retryAfterMs:
      error.retryAfterSeconds === null
        ? undefined
        : error.retryAfterSeconds * 1_000,
  });
}

export function openEventStream(
  api: ApiClient,
  sessionId: string,
  options: StreamOptions = {},
): EventStream {
  const stop = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stop.signal])
    : stop.signal;
  let lastEventId = options.lastEventId || undefined;
  let started = false;
  const queue: SessionEvent[] = [];
  let failure: unknown;
  let ended = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  const start = () => {
    started = true;
    // Ends the iteration at once, not when the connection gets round to closing.
    signal.addEventListener(
      "abort",
      () => {
        ended = true;
        notify();
      },
      { once: true },
    );
    subscribeSessionEvents(api, sessionId, {
      signal,
      ...(lastEventId ? { lastEventId } : {}),
      onEvent(frame) {
        queue.push(toEvent(frame));
        notify();
      },
      onError(error) {
        failure = fromClientError(error);
      },
    })
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        ended = true;
        notify();
      });
  };

  return {
    get lastEventId() {
      return lastEventId;
    },
    close() {
      stop.abort();
    },
    async *[Symbol.asyncIterator]() {
      if (started) throw new TypeError("an event stream is read once");
      start();
      try {
        for (;;) {
          const event = queue.shift();
          if (event) {
            lastEventId = event.id;
            yield event;
            continue;
          }
          if (ended) {
            if (failure !== undefined) throw failure;
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        stop.abort();
      }
    },
  };
}

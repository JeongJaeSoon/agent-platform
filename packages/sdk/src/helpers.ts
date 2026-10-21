import type { Werft } from "./client.ts";
import { AbortedError, isApiError, TurnBlockedError } from "./core/errors.ts";
import { isTransient } from "./core/request.ts";
import type {
  AnswerAccepted,
  AnswerBody,
  PendingRequest,
  PermissionDecision,
  PermissionRequest,
  PushRequest,
  PushRequestId,
  QuestionAnswer,
  QuestionRequest,
  Receipt,
  ReceiptId,
  RequestId,
  SessionEvent,
  SessionId,
  Turn,
  TurnId,
} from "./types.ts";

type Maybe<T> = T | undefined | Promise<T | undefined>;

/**
 * A handler is a security boundary: allow exact inputs only. Returning
 * undefined leaves the request open for a person in the console or Slack.
 */
export interface PendingRequestHandlers {
  permission?(
    request: PermissionRequest,
    context: { signal: AbortSignal },
  ): Maybe<PermissionDecision>;
  question?(
    request: QuestionRequest,
    context: { signal: AbortSignal },
  ): Maybe<QuestionAnswer>;
}

export type AnswerOutcome =
  /** Stored; the receipt may still settle failed or unknown. */
  | { request_id: RequestId; outcome: "accepted"; receipt: AnswerAccepted }
  /** No handler, the handler returned undefined, or a kind this SDK does not know. */
  | { request_id: RequestId; outcome: "left_open" }
  | {
      request_id: RequestId;
      outcome: "too_late";
      code: "REQUEST_EXPIRED" | "REQUEST_STALE";
    }
  /** IDEMPOTENCY_CONFLICT: a different answer was stored first. */
  | { request_id: RequestId; outcome: "conflict" };

const TERMINAL_TURN = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
]);
// Nothing ends a turn in these until someone acts; pausing, resuming,
// stopping and closing pass on their own.
const BLOCKED_ADMISSION = new Set([
  "paused",
  "stopped",
  "recovery_required",
  "closed",
]);
const OPEN_PUSH = new Set(["requested", "approved", "pushing"]);

const ended = (turn: Turn) =>
  TERMINAL_TURN.has(turn.status) || turn.ended_at !== null;

const never = new AbortController().signal;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortedError(signal.reason);
}

const optionsOf = (signal: AbortSignal | undefined) =>
  signal ? { signal } : {};

async function decide(
  request: PendingRequest,
  handlers: PendingRequestHandlers,
  signal: AbortSignal,
): Promise<AnswerBody | undefined> {
  if (request.kind === "permission" && handlers.permission) {
    const decision = await handlers.permission(request as PermissionRequest, {
      signal,
    });
    if (!decision) return undefined;
    if (decision.decision === "deny" && !decision.reason?.trim())
      throw new TypeError("a denial needs a reason the model can act on");
    return {
      request_id: request.request_id,
      kind: "permission",
      decision: decision.decision,
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
  }
  if (request.kind === "question" && handlers.question) {
    const answer = await handlers.question(request as QuestionRequest, {
      signal,
    });
    if (!answer) return undefined;
    return {
      request_id: request.request_id,
      kind: "question",
      answers: answer.answers,
    };
  }
  return undefined;
}

async function answerOne(
  client: Werft,
  sessionId: SessionId,
  request: PendingRequest,
  handlers: PendingRequestHandlers,
  signal: AbortSignal | undefined,
): Promise<AnswerOutcome> {
  const { request_id } = request;
  const body = await decide(request, handlers, signal ?? never);
  if (!body) return { request_id, outcome: "left_open" };
  try {
    const receipt = await client.sessions.requests.answer(
      sessionId,
      body,
      optionsOf(signal),
    );
    return { request_id, outcome: "accepted", receipt };
  } catch (error) {
    if (isApiError(error, "REQUEST_EXPIRED"))
      return { request_id, outcome: "too_late", code: "REQUEST_EXPIRED" };
    if (isApiError(error, "REQUEST_STALE"))
      return { request_id, outcome: "too_late", code: "REQUEST_STALE" };
    if (isApiError(error, "IDEMPOTENCY_CONFLICT"))
      return { request_id, outcome: "conflict" };
    throw error;
  }
}

const oldestFirst = (a: PendingRequest, b: PendingRequest) =>
  a.created_at.localeCompare(b.created_at);

/** Hands every open request of the session, oldest first, to its handler once. */
export async function answerPending(
  client: Werft,
  sessionId: SessionId,
  handlers: PendingRequestHandlers,
  options: { signal?: AbortSignal } = {},
): Promise<AnswerOutcome[]> {
  const requests = await client.sessions.requests.list(
    sessionId,
    optionsOf(options.signal),
  );
  const outcomes: AnswerOutcome[] = [];
  for (const request of [...requests].sort(oldestFirst))
    outcomes.push(
      await answerOne(client, sessionId, request, handlers, options.signal),
    );
  return outcomes;
}

export interface WaitForTurnOptions {
  /** The only deadline: use AbortSignal.timeout(ms). */
  signal?: AbortSignal;
  onRequest?: PendingRequestHandlers;
  onAnswer?(outcome: AnswerOutcome): void;
  /** Default 2_000. */
  pollIntervalMs?: number;
  /**
   * Opt-in: wake on events as well as on the timer, and see them. Costs one
   * of the owner's open streams and, without lastEventId, a replay of the
   * whole session. A failed stream falls back to polling.
   */
  events?: { lastEventId?: string; onEvent?(event: SessionEvent): void };
}

/** A wait that the timer, an event or the signal ends, whichever comes first. */
function waker(signal: AbortSignal | undefined) {
  let pending = false;
  let wakeNow: (() => void) | undefined;
  return {
    wake() {
      if (wakeNow) wakeNow();
      else pending = true;
    },
    nap(ms: number): Promise<void> {
      if (pending || signal?.aborted) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          wakeNow = undefined;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener("abort", done, { once: true });
        wakeNow = done;
      });
    },
  };
}

/** Retryable failures wait for the next poll; any other ends the wait. */
async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (isTransient(error)) return null;
    throw error;
  }
}

/**
 * Resolves with the turn once GET turn shows it ended; a `failed` turn is
 * data, not an error. One loop reads the turn, answers new pending requests
 * of the session (not only this turn's: a queued turn waits on the one
 * ahead) and checks the session is not stuck, then sleeps.
 */
export async function waitForTurn(
  client: Werft,
  sessionId: SessionId,
  turnId: TurnId,
  options: WaitForTurnOptions = {},
): Promise<Turn> {
  const { signal } = options;
  const interval = options.pollIntervalMs ?? 2_000;
  const handed = new Set<RequestId>();
  const timer = waker(signal);
  const streamStop = new AbortController();
  if (options.events) {
    const stream = client.sessions.events.stream(sessionId, {
      signal: signal
        ? AbortSignal.any([signal, streamStop.signal])
        : streamStop.signal,
      ...(options.events.lastEventId
        ? { lastEventId: options.events.lastEventId }
        : {}),
    });
    const onEvent = options.events.onEvent;
    void (async () => {
      try {
        for await (const event of stream) {
          onEvent?.(event);
          timer.wake();
        }
      } catch {
        // Polling carries on without the stream.
      }
    })();
  }

  try {
    for (;;) {
      aborted(signal);
      const turn = await orNull(
        client.sessions.turns.get(sessionId, turnId, optionsOf(signal)),
      );
      if (turn && ended(turn)) return turn;

      if (options.onRequest) {
        const requests = await orNull(
          client.sessions.requests.list(sessionId, optionsOf(signal)),
        );
        for (const request of [...(requests ?? [])].sort(oldestFirst)) {
          if (handed.has(request.request_id)) continue;
          handed.add(request.request_id);
          const outcome = await answerOne(
            client,
            sessionId,
            request,
            options.onRequest,
            signal,
          );
          options.onAnswer?.(outcome);
        }
      }

      const session = await orNull(
        client.sessions.get(sessionId, optionsOf(signal)),
      );
      if (turn && session && BLOCKED_ADMISSION.has(session.admission_state)) {
        // The turn may have ended between the two reads, and the session
        // with it: a close or a stop ends the session right after its turn.
        const again = await orNull(
          client.sessions.turns.get(sessionId, turnId, optionsOf(signal)),
        );
        if (again && ended(again)) return again;
        if (again) throw new TurnBlockedError(session.admission_state);
      }
      await timer.nap(interval);
    }
  } finally {
    streamStop.abort();
  }
}

/** Polls the receipt until it leaves `accepted`. */
export async function waitForReceipt(
  client: Werft,
  receiptId: ReceiptId,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<Receipt> {
  const { signal } = options;
  const timer = waker(signal);
  for (;;) {
    aborted(signal);
    const receipt = await orNull(
      client.receipts.get(receiptId, optionsOf(signal)),
    );
    if (receipt && receipt.status !== "accepted") return receipt;
    await timer.nap(options.pollIntervalMs ?? 1_000);
  }
}

/** Polls until the push request is pushed, failed or rejected. */
export async function waitForPushRequest(
  client: Werft,
  sessionId: SessionId,
  pushRequestId: PushRequestId,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<PushRequest> {
  const { signal } = options;
  const timer = waker(signal);
  for (;;) {
    aborted(signal);
    const push = await orNull(
      client.sessions.pushRequests.get(
        sessionId,
        pushRequestId,
        optionsOf(signal),
      ),
    );
    if (push && !OPEN_PUSH.has(push.state)) return push;
    await timer.nap(options.pollIntervalMs ?? 2_000);
  }
}

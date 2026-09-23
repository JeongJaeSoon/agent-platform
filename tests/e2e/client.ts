/**
 * What tests/e2e drives the stack with: the public /v1 API over HTTP and
 * nothing else — no database, no bucket, no import from apps/. A step that
 * needs more than a curl user has is not a quickstart step. The one
 * exception is test scaffolding, not product: the fake Messages API's
 * control port, which says when a scripted model call is in flight.
 */

export type E2eEnv = { apiKey: string; apiUrl: string; messagesUrl: string };

/** Null unless tests/e2e/run.sh started a stack; the suite never starts one. */
export function e2eEnv(): E2eEnv | null {
  const apiUrl = process.env.E2E_API_URL;
  const apiKey = process.env.E2E_API_KEY;
  const messagesUrl = process.env.E2E_MESSAGES_URL;
  if (!apiUrl || !apiKey || !messagesUrl) return null;
  return { apiKey, apiUrl, messagesUrl };
}

export const PROFILE_ID = "claude-coding-local";
export const REPOSITORY_ID = "sample-app";

export type Step = {
  delayMs?: number;
  input: Record<string, unknown>;
  tool: string;
};

/**
 * A prompt the compose fake Messages API plays as written
 * (packages/testkit/src/scripted-messages.ts): each step is one tool call,
 * then the final text ends the turn.
 */
export function scripted(
  id: string,
  steps: Step[],
  final: string,
  finalDelayMs?: number,
): string {
  const spec = {
    id,
    steps,
    final,
    ...(finalDelayMs === undefined ? {} : { finalDelayMs }),
  };
  return `GATE-SPEC ${JSON.stringify(spec)}`;
}

export type ApiResponse<T> = { body: T; headers: Headers; status: number };

export type ErrorBody = {
  error: { code: string; message: string; retryable: boolean };
};

export type SessionDetail = {
  admission_state: string;
  attention: unknown;
  checkpoint_revision: number | null;
  current_turn_id: string | null;
  id: string;
  pending_request_count: number;
  queued_turn_count: number;
  revision: number;
  status: string;
};

export type Turn = { id: string; status: string } & Record<string, unknown>;

export type Receipt = {
  error: unknown;
  id: string;
  operation: string;
  result: Record<string, unknown> | null;
  status: "accepted" | "succeeded" | "failed" | "unknown";
};

export type PendingRequest = {
  input: Record<string, unknown>;
  kind: "permission" | "question";
  request_id: string;
  tool?: string;
  turn_id: string;
};

const TERMINAL_TURN = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
]);

export class Api {
  constructor(private readonly env: E2eEnv) {}

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey: string | null = method === "POST"
      ? crypto.randomUUID()
      : null,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.env.apiKey}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== null) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(`${this.env.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: (text === "" ? null : JSON.parse(text)) as T,
    };
  }

  /** The body of a response that must have had `status`; anything else throws with it. */
  async expect<T>(
    status: number,
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string | null,
  ): Promise<T> {
    const response = await this.request<T>(method, path, body, idempotencyKey);
    if (response.status !== status) {
      throw new Error(
        `${method} ${path} answered ${response.status}, expected ${status}: ${JSON.stringify(response.body)}`,
      );
    }
    return response.body;
  }

  createSession(message: string, idempotencyKey?: string) {
    return this.request<{
      receipt_id: string;
      session_id: string;
      status: string;
      turn_id: string;
    }>(
      "POST",
      "/v1/sessions",
      { profile_id: PROFILE_ID, repository_id: REPOSITORY_ID, message },
      idempotencyKey,
    );
  }

  session(id: string) {
    return this.expect<SessionDetail>(200, "GET", `/v1/sessions/${id}`);
  }

  turn(sessionId: string, turnId: string) {
    return this.expect<Turn>(
      200,
      "GET",
      `/v1/sessions/${sessionId}/turns/${turnId}`,
    );
  }

  send(sessionId: string, message: string) {
    return this.expect<{ receipt_id: string; turn_id: string }>(
      202,
      "POST",
      `/v1/sessions/${sessionId}/messages`,
      { message },
    );
  }

  async pending(sessionId: string): Promise<PendingRequest[]> {
    const body = await this.expect<{ items: PendingRequest[] }>(
      200,
      "GET",
      `/v1/sessions/${sessionId}/pending-requests`,
    );
    return body.items;
  }

  allow(sessionId: string, requestId: string) {
    return this.expect<{ receipt_id: string }>(
      202,
      "POST",
      `/v1/sessions/${sessionId}/answers`,
      { request_id: requestId, kind: "permission", decision: "allow" },
    );
  }

  /** A control operation's first response, whatever its status. */
  control(sessionId: string, operation: string, body: unknown) {
    return this.request<
      { receipt_id: string; receipt_status: string } | ErrorBody
    >("POST", `/v1/sessions/${sessionId}/${operation}`, body);
  }

  receipt(id: string) {
    return this.expect<Receipt>(200, "GET", `/v1/receipts/${id}`);
  }

  /**
   * Waits until the fake Messages API has received the call for `step` of
   * the script `specId` (the final text is step `steps.length`), so a
   * control sent next lands while that call is in flight.
   */
  async modelCallSeen(specId: string, step: number): Promise<void> {
    await poll(`model call ${specId}#${step}`, 180_000, async () => {
      const response = await fetch(
        `${this.env.messagesUrl}/requests?spec=${encodeURIComponent(specId)}`,
      );
      const calls = (await response.json()) as Array<{ step: number }>;
      return calls.some((call) => call.step === step) ? true : null;
    });
  }

  /** Polls until the turn reaches a terminal status and returns it. */
  async settledTurn(
    sessionId: string,
    turnId: string,
    timeoutMs = 180_000,
  ): Promise<Turn> {
    return poll(
      `turn ${turnId} of ${sessionId} to settle`,
      timeoutMs,
      async () => {
        const turn = await this.turn(sessionId, turnId);
        return TERMINAL_TURN.has(turn.status) ? turn : null;
      },
    );
  }

  /** Polls the session until `accept` holds for its detail. */
  async sessionUntil(
    sessionId: string,
    what: string,
    accept: (detail: SessionDetail) => boolean,
    timeoutMs = 180_000,
  ): Promise<SessionDetail> {
    return poll(`${sessionId} ${what}`, timeoutMs, async () => {
      const detail = await this.session(sessionId);
      return accept(detail) ? detail : null;
    });
  }

  async pendingUntil(
    sessionId: string,
    count: number,
    timeoutMs = 180_000,
  ): Promise<PendingRequest[]> {
    return poll(
      `${count} pending request(s) on ${sessionId}`,
      timeoutMs,
      async () => {
        const items = await this.pending(sessionId);
        return items.length >= count ? items : null;
      },
    );
  }

  async receiptUntil(
    id: string,
    accept: (receipt: Receipt) => boolean,
    timeoutMs = 180_000,
  ): Promise<Receipt> {
    return poll(`receipt ${id}`, timeoutMs, async () => {
      const receipt = await this.receipt(id);
      return accept(receipt) ? receipt : null;
    });
  }

  /**
   * Reads the SSE stream from the start until `stop` sees the event it
   * waits for, and returns every event read.
   */
  async events(
    sessionId: string,
    stop: (event: SseEvent) => boolean,
    timeoutMs = 180_000,
  ): Promise<SseEvent[]> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const seen: SseEvent[] = [];
    try {
      const response = await fetch(
        `${this.env.apiUrl}/v1/sessions/${sessionId}/events`,
        {
          headers: { authorization: `Bearer ${this.env.apiKey}` },
          signal: abort.signal,
        },
      );
      if (response.status !== 200 || response.body === null) {
        throw new Error(`events answered ${response.status}`);
      }
      for await (const event of parseSse(response.body)) {
        seen.push(event);
        if (stop(event)) return seen;
      }
      throw new Error(`event stream ended; saw ${describe(seen)}`);
    } catch (error) {
      if (abort.signal.aborted) {
        throw new Error(
          `no matching event in ${timeoutMs}ms; saw ${describe(seen)}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}

export type SseEvent = {
  data: { data: Record<string, unknown>; turn_id: string | null };
  event: string;
  id: string;
};

function describe(events: SseEvent[]): string {
  return events.map((event) => event.event).join(",") || "nothing";
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      const fields: Record<string, string> = {};
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const value = line.slice(colon + 1).replace(/^ /, "");
        const key = line.slice(0, colon);
        fields[key] = key in fields ? `${fields[key]}\n${value}` : value;
      }
      if (fields.event === undefined || fields.data === undefined) continue;
      yield {
        id: fields.id ?? "",
        event: fields.event,
        data: JSON.parse(fields.data),
      };
    }
  }
}

export async function poll<T>(
  what: string,
  timeoutMs: number,
  attempt: () => Promise<T | null>,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await attempt();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}

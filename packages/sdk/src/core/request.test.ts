import { describe, expect, test } from "bun:test";
import {
  AbortedError,
  APIError,
  ConnectionError,
  isApiError,
  TimeoutError,
  WerftError,
} from "../index.ts";
import { apiError, fakeApi, json, werft } from "../testing/fake-api.ts";
import {
  type Attempt,
  type CallKind,
  call,
  type RetryPolicy,
} from "./request.ts";

const ACCEPTED = { receipt_id: "r1", receipt_status: "accepted" };

/** A policy that records its waits instead of sleeping. */
function policy(overrides: Partial<RetryPolicy> = {}) {
  const waits: number[] = [];
  return {
    waits,
    policy: {
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
      timeoutMs: 1_000,
      random: () => 1,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      ...overrides,
    } satisfies RetryPolicy,
  };
}

/** Answers the attempts in order; a thrown value is a lost connection. */
function scripted(answers: (Response | Error)[]) {
  const keys: string[] = [];
  let attempt = 0;
  const run: Attempt<unknown> = async ({ idempotencyKey }) => {
    keys.push(idempotencyKey);
    const answer = answers[Math.min(attempt++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    const response = answer as Response;
    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    return response.ok ? { data: body, response } : { error: body, response };
  };
  return { run, keys, count: () => attempt };
}

async function outcome(
  answers: (Response | Error)[],
  kind: CallKind = "keyed",
  overrides: Partial<RetryPolicy> = {},
) {
  const { policy: p, waits } = policy(overrides);
  const script = scripted(answers);
  const result: { data?: unknown; error?: unknown } = await call(
    p,
    kind,
    script.run,
  ).then(
    (data) => ({ data }),
    (error: unknown) => ({ error }),
  );
  return { ...result, waits, keys: script.keys, attempts: script.count() };
}

describe("retry policy", () => {
  test("retries a response the server marks retryable", async () => {
    const result = await outcome([
      apiError(503, "BACKEND_UNAVAILABLE", { retryable: true }),
      json(202, ACCEPTED),
    ]);
    expect(result.data).toEqual(ACCEPTED);
    expect(result.attempts).toBe(2);
  });

  test("retries a 502 or 504 that a proxy answered", async () => {
    for (const status of [502, 504]) {
      const result = await outcome([
        new Response("<html>bad gateway</html>", { status }),
        json(202, ACCEPTED),
      ]);
      expect(result.attempts).toBe(2);
      expect(result.data).toEqual(ACCEPTED);
    }
  });

  test("retries a lost connection for reads and keyed commands only", async () => {
    const lost = new TypeError("socket hang up");
    for (const kind of ["read", "keyed"] as const) {
      const result = await outcome([lost, json(200, ACCEPTED)], kind);
      expect(result.attempts).toBe(2);
    }
    const unkeyed = await outcome([lost, json(200, ACCEPTED)], "unkeyed");
    expect(unkeyed.attempts).toBe(1);
    expect(unkeyed.error).toBeInstanceOf(ConnectionError);
    expect((unkeyed.error as ConnectionError).code).toBe("NETWORK_ERROR");
  });

  test("never retries a 409 or a 500, whatever the body says", async () => {
    for (const [status, code] of [
      [409, "REVISION_CONFLICT"],
      [409, "IDEMPOTENCY_CONFLICT"],
      [500, "INTERNAL_ERROR"],
    ] as const) {
      const result = await outcome([
        apiError(status, code, { retryable: true }),
        json(202, ACCEPTED),
      ]);
      expect(result.attempts).toBe(1);
      expect(isApiError(result.error, code)).toBe(true);
    }
  });

  test("does not retry a 4xx or a 503 the server did not mark retryable", async () => {
    for (const answer of [
      apiError(400, "BAD_REQUEST"),
      apiError(403, "FORBIDDEN"),
      new Response("down", { status: 503 }),
    ]) {
      const result = await outcome([answer, json(202, ACCEPTED)]);
      expect(result.attempts).toBe(1);
    }
  });

  test("waits for Retry-After, converted to milliseconds", async () => {
    const result = await outcome([
      apiError(
        429,
        "RATE_LIMITED",
        { retryable: true },
        { "retry-after": "5" },
      ),
      json(202, ACCEPTED),
    ]);
    expect(result.waits).toEqual([5_000]);
  });

  test("fails at once when Retry-After is over the 60 s ceiling", async () => {
    const result = await outcome([
      apiError(
        429,
        "RATE_LIMITED",
        { retryable: true },
        { "retry-after": "61" },
      ),
      json(202, ACCEPTED),
    ]);
    expect(result.attempts).toBe(1);
    expect(result.waits).toEqual([]);
    expect((result.error as APIError).retryAfterMs).toBe(61_000);
  });

  test("backs off min(0.5 s·2^n, 8 s) with full jitter, maxRetries 2", async () => {
    const result = await outcome(
      [apiError(503, "BACKEND_UNAVAILABLE", { retryable: true })],
      "keyed",
    );
    expect(result.attempts).toBe(3);
    expect(result.waits).toEqual([500, 1_000]);
    expect((result.error as WerftError).attempts).toBe(3);
    const capped = await outcome(
      [apiError(503, "BACKEND_UNAVAILABLE", { retryable: true })],
      "keyed",
      { maxRetries: 6 },
    );
    expect(capped.waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000]);
    const ceiling = await outcome([new TypeError("reset")], "keyed", {
      maxRetryDelayMs: 100,
    });
    expect(ceiling.waits).toEqual([100, 100]);
  });

  test("an attempt over timeoutMs is a TimeoutError and is retried", async () => {
    const { policy: p } = policy({ timeoutMs: 20, maxRetries: 1 });
    let attempts = 0;
    const error = await call(p, "read", ({ signal }) => {
      attempts++;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).code).toBe("TIMEOUT");
    expect(attempts).toBe(2);
  });
});

describe("Idempotency-Key", () => {
  test("one key per call, sent again on every retry", async () => {
    const result = await outcome([
      new TypeError("reset"),
      apiError(503, "BACKEND_UNAVAILABLE", { retryable: true }),
      json(202, ACCEPTED),
    ]);
    expect(result.keys).toHaveLength(3);
    expect(new Set(result.keys).size).toBe(1);
    expect(result.keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    const next = await outcome([json(202, ACCEPTED)]);
    expect(next.keys[0]).not.toBe(result.keys[0]);
  });

  test("every error of a keyed command carries its key", async () => {
    const api = await outcome([apiError(409, "REVISION_CONFLICT")]);
    expect((api.error as APIError).idempotencyKey).toBe(api.keys[0]);
    const lost = await outcome([new TypeError("reset")], "keyed", {
      maxRetries: 0,
    });
    expect((lost.error as ConnectionError).idempotencyKey).toBe(lost.keys[0]);
  });

  test("an abort carries the key, is named AbortError and keeps the reason", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const { policy: p } = policy();
    const keys: string[] = [];
    const error = await call(
      p,
      "keyed",
      ({ signal, idempotencyKey }) => {
        keys.push(idempotencyKey);
        controller.abort(reason);
        return Promise.reject(signal.reason);
      },
      { signal: controller.signal },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AbortedError);
    expect((error as AbortedError).name).toBe("AbortError");
    expect((error as AbortedError).cause).toBe(reason);
    expect((error as AbortedError).idempotencyKey).toBe(keys[0]);
  });

  test("a caller's key wins over the generated one", async () => {
    const { policy: p } = policy();
    const script = scripted([json(202, ACCEPTED)]);
    await call(p, "keyed", script.run, { idempotencyKey: "mine" });
    expect(script.keys).toEqual(["mine"]);
  });

  test("reads and unkeyed commands carry no key", async () => {
    const result = await outcome([apiError(404, "NOT_FOUND")], "read");
    expect((result.error as APIError).idempotencyKey).toBeUndefined();
  });
});

describe("errors", () => {
  test("APIError keeps the server's code, retryable flag, request id and details", async () => {
    const result = await outcome([
      apiError(409, "SESSION_PAUSED", {
        details: { admission_state: "paused" },
      }),
    ]);
    const error = result.error as APIError;
    expect(error).toBeInstanceOf(APIError);
    expect(error).toBeInstanceOf(WerftError);
    expect(error.name).toBe("APIError");
    expect(error.status).toBe(409);
    expect(error.code).toBe("SESSION_PAUSED");
    expect(error.retryable).toBe(false);
    expect(error.requestId).toBe("req_1");
    expect(error.details).toEqual({ admission_state: "paused" });
  });

  test("a code this SDK has never heard of is kept as sent", async () => {
    const result = await outcome([apiError(409, "BRAND_NEW_CODE")]);
    expect((result.error as APIError).code).toBe("BRAND_NEW_CODE");
    expect(isApiError(result.error, "BRAND_NEW_CODE")).toBe(true);
    expect(isApiError(result.error, "NOT_FOUND")).toBe(false);
  });

  test("a body that is not the API's error shape reads as UNKNOWN with the status text", async () => {
    const result = await outcome([
      new Response("nope", {
        status: 418,
        statusText: "I'm a teapot",
        headers: { "x-request-id": "req_proxy" },
      }),
    ]);
    const error = result.error as APIError;
    expect(error.code).toBe("UNKNOWN");
    expect(error.message).toBe("I'm a teapot");
    expect(error.requestId).toBe("req_proxy");
  });

  test("errors reach the caller through the real client too", async () => {
    const api = fakeApi(() => apiError(404, "NOT_FOUND"));
    const error = await werft(api.fetch)
      .sessions.get("s1")
      .catch((e: unknown) => e);
    expect(isApiError(error, "NOT_FOUND")).toBe(true);
    expect(api.seen).toHaveLength(1);
  });
});

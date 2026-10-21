import { describe, expect, test } from "bun:test";
import {
  AbortedError,
  type AnswerOutcome,
  answerPending,
  type PendingRequestHandlers,
  TurnBlockedError,
  waitForPushRequest,
  waitForReceipt,
  waitForTurn,
} from "./index.ts";
import {
  apiError,
  fakeApi,
  json,
  type Seen,
  werft,
} from "./testing/fake-api.ts";

const NOW = "2026-10-21T00:00:00.000Z";

function turn(status: string, ended = false) {
  return {
    turn_id: "t1",
    session_id: "s1",
    status,
    message: "hi",
    terminal_reason: null,
    checkpoint_revision: null,
    created_at: NOW,
    started_at: NOW,
    ended_at: ended ? NOW : null,
    result: null,
    usage: null,
    attempts: [],
  };
}

function permission(id: string, command: string, created_at = NOW) {
  return {
    request_id: id,
    turn_id: "t1",
    attempt_id: "a1",
    created_at,
    expires_at: NOW,
    kind: "permission",
    tool: "Bash",
    input: { command },
  };
}

/**
 * A session whose turn needs every pending request answered before it
 * completes. `admission` is read on each GET session.
 */
function session(
  pending: unknown[],
  options: { admission?: () => string; answer?: () => Response } = {},
) {
  const open = [...pending];
  const api = fakeApi((request: Seen) => {
    const { method, path } = request;
    if (method === "GET" && path === "/v1/sessions/s1/turns/t1")
      return json(
        200,
        open.length === 0 ? turn("completed", true) : turn("needs_input"),
      );
    if (method === "GET" && path === "/v1/sessions/s1/pending-requests")
      return json(200, { items: open });
    if (method === "POST" && path === "/v1/sessions/s1/answers") {
      const answer = options.answer?.();
      if (answer) return answer;
      const id = (request.body as { request_id: string }).request_id;
      open.splice(
        open.findIndex((r) => (r as { request_id: string }).request_id === id),
        1,
      );
      return json(202, { receipt_id: `r-${id}`, receipt_status: "accepted" });
    }
    if (method === "GET" && path === "/v1/sessions/s1")
      return json(200, {
        admission_state: options.admission?.() ?? "active",
        attention: null,
      });
    return apiError(404, "NOT_FOUND");
  });
  return { ...api, open };
}

const ALLOWED = new Set(["git status"]);
const allowList: PendingRequestHandlers = {
  permission(request) {
    const command = (request.input as { command?: unknown } | null)?.command;
    if (typeof command === "string" && ALLOWED.has(command))
      return { decision: "allow" };
    return { decision: "deny", reason: "only git status is allowed" };
  },
};

describe("waitForTurn", () => {
  test("answers a pending permission request in the same loop and returns the ended turn", async () => {
    const api = session([
      permission("p2", "rm -rf /", "2026-10-21T00:00:02.000Z"),
      permission("p1", "git status", "2026-10-21T00:00:01.000Z"),
    ]);
    const outcomes: AnswerOutcome[] = [];
    const ended = await waitForTurn(werft(api.fetch), "s1", "t1", {
      onRequest: allowList,
      onAnswer: (outcome) => outcomes.push(outcome),
      pollIntervalMs: 5,
    });
    expect(ended.status).toBe("completed");
    const answers = api.seen.filter((r) => r.path.endsWith("/answers"));
    // Oldest first, each with its own fixed key.
    expect(answers.map((r) => r.body)).toEqual([
      { request_id: "p1", kind: "permission", decision: "allow" },
      {
        request_id: "p2",
        kind: "permission",
        decision: "deny",
        reason: "only git status is allowed",
      },
    ]);
    expect(answers.map((r) => r.headers.get("idempotency-key"))).toEqual([
      "answer:p1",
      "answer:p2",
    ]);
    expect(outcomes.map((o) => [o.request_id, o.outcome])).toEqual([
      ["p1", "accepted"],
      ["p2", "accepted"],
    ]);
  });

  test("a request no handler takes is left open and handed over only once", async () => {
    const api = session([permission("p1", "git status")]);
    const outcomes: AnswerOutcome[] = [];
    const controller = new AbortController();
    const wait = waitForTurn(werft(api.fetch), "s1", "t1", {
      onRequest: { question: () => undefined },
      onAnswer: (outcome) => {
        outcomes.push(outcome);
      },
      pollIntervalMs: 5,
      signal: controller.signal,
    });
    await Bun.sleep(40);
    controller.abort();
    expect(await wait.catch((e: unknown) => e)).toBeInstanceOf(AbortedError);
    expect(outcomes).toEqual([{ request_id: "p1", outcome: "left_open" }]);
    expect(api.seen.some((r) => r.path.endsWith("/answers"))).toBe(false);
  });

  test("a deny without a reason is refused before it is sent", async () => {
    const api = session([permission("p1", "git status")]);
    const error = await waitForTurn(werft(api.fetch), "s1", "t1", {
      onRequest: {
        permission: () => ({ decision: "deny" }) as never,
      },
      pollIntervalMs: 5,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(api.seen.some((r) => r.path.endsWith("/answers"))).toBe(false);
  });

  test("an answer that came too late or conflicts is an outcome, not a failure", async () => {
    for (const [code, expected] of [
      ["REQUEST_EXPIRED", { outcome: "too_late", code: "REQUEST_EXPIRED" }],
      ["REQUEST_STALE", { outcome: "too_late", code: "REQUEST_STALE" }],
      ["IDEMPOTENCY_CONFLICT", { outcome: "conflict" }],
    ] as const) {
      const api = session([permission("p1", "git status")], {
        answer: () => apiError(409, code),
      });
      const outcomes = await answerPending(werft(api.fetch), "s1", allowList);
      expect(outcomes).toEqual([{ request_id: "p1", ...expected }]);
    }
  });

  test("fails with TurnBlockedError once the session leaves active for a state that needs someone", async () => {
    const api = session([permission("p1", "git status")], {
      admission: () => "paused",
    });
    const error = await waitForTurn(werft(api.fetch), "s1", "t1", {
      pollIntervalMs: 5,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TurnBlockedError);
    expect((error as TurnBlockedError).code).toBe("TURN_BLOCKED");
    expect((error as TurnBlockedError).details).toEqual({
      admission_state: "paused",
    });
  });

  test("a turn that ended just before the session closed is returned, not reported blocked", async () => {
    let turnReads = 0;
    const api = fakeApi(({ path }) =>
      path === "/v1/sessions/s1"
        ? json(200, { admission_state: "closed", attention: null })
        : json(
            200,
            ++turnReads === 1 ? turn("running") : turn("completed", true),
          ),
    );
    const ended = await waitForTurn(werft(api.fetch), "s1", "t1", {
      pollIntervalMs: 5,
    });
    expect(ended.status).toBe("completed");
    expect(turnReads).toBe(2);
  });

  test("keeps waiting through a state that passes on its own", async () => {
    const states = ["closing", "pausing", "active"];
    const api = session([permission("p1", "git status")], {
      admission: () => states.shift() ?? "active",
    });
    const ended = await waitForTurn(werft(api.fetch), "s1", "t1", {
      onRequest: allowList,
      pollIntervalMs: 5,
    });
    expect(ended.status).toBe("completed");
  });

  test("a turn status newer than this SDK still ends the wait when ended_at is set", async () => {
    const api = fakeApi(() => json(200, turn("brand_new_terminal", true)));
    const ended = await waitForTurn(werft(api.fetch), "s1", "t1");
    expect(ended.status).toBe("brand_new_terminal");
  });

  test("a retryable read failure waits for the next poll; a 403 ends the wait", async () => {
    let calls = 0;
    const flaky = fakeApi(() =>
      ++calls === 1
        ? apiError(503, "BACKEND_UNAVAILABLE", { retryable: true })
        : json(200, turn("completed", true)),
    );
    const ended = await waitForTurn(
      werft(flaky.fetch, { maxRetries: 0 }),
      "s1",
      "t1",
      { pollIntervalMs: 5 },
    );
    expect(ended.status).toBe("completed");

    const forbidden = fakeApi(() => apiError(403, "FORBIDDEN"));
    const error = await waitForTurn(werft(forbidden.fetch), "s1", "t1", {
      pollIntervalMs: 5,
    }).catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("FORBIDDEN");
  });
});

describe("waitForReceipt and waitForPushRequest", () => {
  test("poll until the receipt leaves accepted", async () => {
    const statuses = ["accepted", "accepted", "succeeded"];
    const api = fakeApi(() =>
      json(200, { id: "r1", operation: "close", status: statuses.shift() }),
    );
    const receipt = await waitForReceipt(werft(api.fetch), "r1", {
      pollIntervalMs: 5,
    });
    expect(receipt.status).toBe("succeeded");
    expect(api.seen).toHaveLength(3);
  });

  test("poll until the push request is pushed, failed or rejected", async () => {
    const states = ["requested", "approved", "pushing", "pushed"];
    const api = fakeApi(() => json(200, { id: "pr1", state: states.shift() }));
    const push = await waitForPushRequest(werft(api.fetch), "s1", "pr1", {
      pollIntervalMs: 5,
    });
    expect(push.state).toBe("pushed");
    expect(api.seen[0]?.path).toBe("/v1/sessions/s1/push-requests/pr1");
  });
});

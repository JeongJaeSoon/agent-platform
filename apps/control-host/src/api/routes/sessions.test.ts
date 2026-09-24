import { describe, expect, test } from "bun:test";
import {
  type ApiErrorCode,
  apiErrorResponseSchema,
} from "@agent-platform/contracts";
import { InvalidCursorError } from "@agent-platform/db";
import {
  createSessionService,
  ownerScopedPolicy,
  type SessionCatalog,
  type SessionControl,
  type SessionReader,
  type SessionUnitOfWork,
} from "@agent-platform/platform";
import { createApiApp } from "../app.ts";
import { registerSessionRoutes } from "./sessions.ts";

const codingProfile: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const catalog: SessionCatalog = {
  profiles: {
    "claude-coding-v1": codingProfile,
    "claude-review-v1": codingProfile,
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
    },
    // Registered, but only claude-review-v1 may run against it.
    "other-app": {
      url: "https://example.invalid/other.git",
      branch: "main",
      profiles: ["claude-review-v1"],
    },
  },
};

function app(
  overrides: Partial<SessionUnitOfWork & SessionReader & SessionControl> = {},
) {
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
    },
    authorization: ownerScopedPolicy,
    catalog,
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      appendInputAtomic: async () => {
        throw new Error("not reached");
      },
      ...overrides,
    },
    controls: {
      terminateAtomic: async () => {
        throw new Error("not reached");
      },
      pauseAtomic: async () => {
        throw new Error("not reached");
      },
      decideRecoveryAtomic: async () => {
        throw new Error("not reached");
      },
      resumeAtomic: async () => {
        throw new Error("not reached");
      },
      ...overrides,
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      getSession: async () => null,
      listTurns: async () => null,
      getTurn: async () => null,
      getReceipt: async () => null,
      readEvents: async () => null,
      ...overrides,
    },
  });
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerSessionRoutes(router, service),
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return app().request("/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  profile_id: "claude-coding-v1",
  repository_id: "sample-app",
  message: "hello",
};

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("POST /v1/sessions validation", () => {
  test("requires Idempotency-Key", async () => {
    const response = await post(valid, { "Idempotency-Key": "" });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("BAD_REQUEST");
  });

  test("rejects unknown profile or repository with 422", async () => {
    const unsupported = async () => ({ outcome: "unsupported" }) as const;
    const request = (body: unknown) =>
      app({ acceptInputAtomic: unsupported }).request("/v1/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Owner-Id": "owner-a",
          "Idempotency-Key": "key-1",
        },
        body: JSON.stringify(body),
      });
    const response = await request({ ...valid, profile_id: "nope" });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("UNSUPPORTED_CAPABILITY");
    expect((await request({ ...valid, repository_id: "nope" })).status).toBe(
      422,
    );
    // Inherited object keys are not registered profiles.
    expect((await request({ ...valid, profile_id: "toString" })).status).toBe(
      422,
    );
    // Both ids registered, but the repository does not allow the profile.
    const disallowed = await request({ ...valid, repository_id: "other-app" });
    expect(disallowed.status).toBe(422);
    expect(await errorCode(disallowed)).toBe("UNSUPPORTED_CAPABILITY");
  });

  test("replays an accepted receipt even when the catalog no longer lists the profile", async () => {
    const replayed = {
      session_id: crypto.randomUUID(),
      turn_id: "1",
      receipt_id: crypto.randomUUID(),
      receipt_status: "accepted",
      status: "queued",
    } as const;
    const response = await app({
      acceptInputAtomic: async (input) => {
        expect(input.repository).toBeNull();
        return { outcome: "replayed", response: replayed };
      },
    }).request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ ...valid, profile_id: "removed-profile" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(replayed);
  });

  test("maps storage connection failures to a retryable 503", async () => {
    const down = Object.assign(new Error("connection terminated"), {
      code: "57P01",
    });
    const response = await app({
      acceptInputAtomic: async () => {
        throw new Error("query failed", { cause: down });
      },
    }).request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(valid),
    });
    expect(response.status).toBe(503);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    const list = await app({
      listSessions: async () => {
        throw down;
      },
    }).request("/v1/sessions", { headers: { "X-Owner-Id": "owner-a" } });
    expect(list.status).toBe(503);
    const saturated = await app({
      listSessions: async () => {
        throw Object.assign(new Error("too many connections"), {
          code: "53300",
        });
      },
    }).request("/v1/sessions", { headers: { "X-Owner-Id": "owner-a" } });
    expect(saturated.status).toBe(503);
  });

  test("answers 413 for an oversized body and for an oversized message", async () => {
    const body = await post({ ...valid, message: "x".repeat(65 * 1024) });
    expect(body.status).toBe(413);
    const message = await post({ ...valid, message: "x".repeat(33 * 1024) });
    expect(message.status).toBe(413);
    expect(await errorCode(message)).toBe("PAYLOAD_TOO_LARGE");
    expect(
      (
        await post(
          { ...valid, message: "x".repeat(31 * 1024) },
          { "Idempotency-Key": "k" },
        )
      ).status,
    ).toBe(500);
  });
});

describe("GET /v1/sessions validation", () => {
  test("rejects limit above 100 and unknown status", async () => {
    const headers = { "X-Owner-Id": "owner-a" };
    expect(
      (await app().request("/v1/sessions?limit=101", { headers })).status,
    ).toBe(400);
    expect(
      (await app().request("/v1/sessions?status=bogus", { headers })).status,
    ).toBe(400);
    expect(
      (await app().request("/v1/sessions?limit=100", { headers })).status,
    ).toBe(200);
  });

  test("treats a malformed session id as not found", async () => {
    const response = await app().request("/v1/sessions/not-a-uuid", {
      headers: { "X-Owner-Id": "owner-a" },
    });
    expect(response.status).toBe(404);
  });
});

const sessionId = "019a0000-0000-7000-8000-000000000001";
const messagesPath = `/v1/sessions/${sessionId}/messages`;

function postMessage(
  body: unknown,
  overrides: Partial<SessionUnitOfWork & SessionReader> = {},
  headers: Record<string, string> = {},
  path = messagesPath,
) {
  return app(overrides).request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/sessions/{id}/messages validation", () => {
  const accepted = {
    turn_id: "2",
    receipt_id: crypto.randomUUID(),
    receipt_status: "accepted",
  } as const;

  test("answers 202 with the acceptance and defaults mode to enqueue", async () => {
    const response = await postMessage(
      { message: "Apply the proposed fix." },
      {
        appendInputAtomic: async (input) => {
          expect(input).toMatchObject({
            principal: { ownerId: "owner-a" },
            sessionId,
            idempotencyKey: "key-1",
            message: "Apply the proposed fix.",
          });
          return { outcome: "accepted", response: accepted };
        },
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(accepted);
  });

  test("requires Idempotency-Key and rejects unknown mode or extra fields", async () => {
    const missing = await postMessage(
      { message: "hi" },
      {},
      { "Idempotency-Key": "" },
    );
    expect(missing.status).toBe(400);
    expect((await postMessage({ message: "hi", mode: "steer" })).status).toBe(
      400,
    );
    expect((await postMessage({ message: "hi", extra: 1 })).status).toBe(400);
    expect((await postMessage({ message: "" })).status).toBe(400);
    expect((await postMessage({ message: "x".repeat(33 * 1024) })).status).toBe(
      413,
    );
  });

  test("treats a malformed session id and an unknown session as 404", async () => {
    const malformed = await postMessage(
      { message: "hi" },
      {},
      {},
      "/v1/sessions/not-a-uuid/messages",
    );
    expect(malformed.status).toBe(404);
    const unknown = await postMessage(
      { message: "hi" },
      { appendInputAtomic: async () => ({ outcome: "not_found" }) },
    );
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("NOT_FOUND");
  });

  test("maps admission states to 409 codes", async () => {
    const cases = [
      ["pausing", "SESSION_PAUSED"],
      ["paused", "SESSION_PAUSED"],
      ["resuming", "SESSION_RESUMING"],
      ["stopping", "SESSION_STOPPED"],
      ["stopped", "SESSION_STOPPED"],
      ["recovery_required", "RECOVERY_REQUIRED"],
      ["closed", "SESSION_CLOSED"],
    ] as const;
    for (const [admissionState, code] of cases) {
      const response = await postMessage(
        { message: "hi" },
        {
          appendInputAtomic: async () => ({
            outcome: "rejected",
            admissionState,
          }),
        },
      );
      expect(response.status, admissionState).toBe(409);
      expect(await errorCode(response), admissionState).toBe(code);
    }
    const conflict = await postMessage(
      { message: "hi" },
      { appendInputAtomic: async () => ({ outcome: "conflict" }) },
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("maps storage connection failures to a retryable 503", async () => {
    const response = await postMessage(
      { message: "hi" },
      {
        appendInputAtomic: async () => {
          throw new Error("query failed", {
            cause: Object.assign(new Error("down"), { code: "08006" }),
          });
        },
      },
    );
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("BACKEND_UNAVAILABLE");
  });
});

describe("GET /v1/sessions/{id}/turns validation", () => {
  const headers = { "X-Owner-Id": "owner-a" };

  test("answers 404 for a foreign session, 400 for a bad limit or cursor", async () => {
    expect(
      (await app().request(`/v1/sessions/${sessionId}/turns`, { headers }))
        .status,
    ).toBe(404);
    expect(
      (
        await app().request(`/v1/sessions/${sessionId}/turns?limit=0`, {
          headers,
        })
      ).status,
    ).toBe(400);
    const badCursor = await app({
      listTurns: async () => {
        throw new InvalidCursorError();
      },
    }).request(`/v1/sessions/${sessionId}/turns?cursor=nope`, { headers });
    expect(badCursor.status).toBe(400);
  });

  test("answers 404 for a turn the reader does not return", async () => {
    expect(
      (
        await app().request(`/v1/sessions/${sessionId}/turns/1`, {
          headers,
        })
      ).status,
    ).toBe(404);
    const foreign = await app().request(`/v1/sessions/${sessionId}/turns/1`, {
      headers: { "X-Owner-Id": "owner-b" },
    });
    expect(foreign.status).toBe(404);
    expect(
      apiErrorResponseSchema.parse(await foreign.json()).error.details,
    ).toBeNull();
  });
});

describe("POST /v1/sessions/{id}/terminate validation", () => {
  const terminatePath = `/v1/sessions/${sessionId}/terminate`;
  const terminate = (
    body: unknown,
    overrides: Partial<SessionControl> = {},
    headers: Record<string, string> = {},
    path = terminatePath,
  ) =>
    app(overrides).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  test("answers 202 with the receipt and says external effects are not reverted", async () => {
    const receiptId = crypto.randomUUID();
    const response = await terminate(
      { expected_revision: 3, reason: "stuck" },
      {
        terminateAtomic: async (input) => {
          expect(input).toMatchObject({
            principal: { ownerId: "owner-a" },
            sessionId,
            idempotencyKey: "key-1",
            expectedRevision: 3,
            reason: "stuck",
          });
          return {
            outcome: "accepted",
            response: { receipt_id: receiptId, receipt_status: "accepted" },
          };
        },
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "accepted",
      external_effects_reverted: false,
    });
  });

  test("requires Idempotency-Key, expected_revision, and rejects extra fields", async () => {
    expect(
      (await terminate({ expected_revision: 1 }, {}, { "Idempotency-Key": "" }))
        .status,
    ).toBe(400);
    expect((await terminate({ reason: "no revision" })).status).toBe(400);
    expect(
      (await terminate({ expected_revision: 1, force: true })).status,
    ).toBe(400);
  });

  test("maps revision conflict, closed session and unknown session", async () => {
    const conflict = await terminate(
      { expected_revision: 1 },
      {
        terminateAtomic: async () => ({
          outcome: "revision_conflict",
          currentRevision: 4,
        }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("REVISION_CONFLICT");
    const closed = await terminate(
      { expected_revision: 1 },
      {
        terminateAtomic: async () => ({
          outcome: "rejected",
          admissionState: "closed",
        }),
      },
    );
    expect(closed.status).toBe(409);
    expect(await errorCode(closed)).toBe("SESSION_CLOSED");
    const missing = await terminate(
      { expected_revision: 1 },
      { terminateAtomic: async () => ({ outcome: "not_found" }) },
    );
    expect(missing.status).toBe(404);
    const legacy = await terminate(
      { expected_revision: 1 },
      { terminateAtomic: async () => ({ outcome: "unsupported" }) },
    );
    expect(legacy.status).toBe(422);
    expect(await errorCode(legacy)).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      (
        await terminate(
          { expected_revision: 1 },
          {},
          {},
          "/v1/sessions/not-a-uuid/terminate",
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /v1/sessions/{id}/recovery-decisions validation", () => {
  const path = `/v1/sessions/${sessionId}/recovery-decisions`;
  const decide = (
    body: unknown,
    overrides: Partial<SessionControl> = {},
    headers: Record<string, string> = {},
  ) =>
    app(overrides).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const abandon = {
    decision: "abandon",
    expected_revision: 3,
    target_turn_id: "1",
    reason: "reviewed",
  };

  test("answers 202 with the decision receipt", async () => {
    const receiptId = crypto.randomUUID();
    const response = await decide(abandon, {
      decideRecoveryAtomic: async (input) => {
        expect(input).toMatchObject({
          principal: { ownerId: "owner-a" },
          sessionId,
          idempotencyKey: "key-1",
          decision: abandon,
        });
        return {
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "succeeded" },
        };
      },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "succeeded",
    });
  });

  test("confirm_completed without evidence_ref, unknown decision and extra fields are 400", async () => {
    expect(
      (
        await decide({
          decision: "confirm_completed",
          expected_revision: 1,
          target_turn_id: "1",
          reason: "r",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await decide({
          decision: "retry",
          expected_revision: 1,
          target_turn_id: "1",
          reason: "r",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await decide({
          decision: "close",
          expected_revision: 1,
          reason: "r",
          target_turn_id: "1",
        })
      ).status,
    ).toBe(400);
    expect((await decide(abandon, {}, { "Idempotency-Key": "" })).status).toBe(
      400,
    );
    // start_fresh names no turn: the context it gives up is all of it.
    expect(
      (
        await decide({
          decision: "start_fresh",
          expected_revision: 1,
          reason: "r",
          target_turn_id: "1",
        })
      ).status,
    ).toBe(400);
  });

  test("start_fresh and retry_restore reach the transaction as they were sent", async () => {
    for (const body of [
      {
        decision: "start_fresh" as const,
        expected_revision: 3,
        reason: "the checkpoint is gone; continue without it",
      },
      {
        decision: "retry_restore" as const,
        expected_revision: 3,
        reason: "the proxy is fixed; restore the same checkpoint",
      },
    ]) {
      const response = await decide(body, {
        decideRecoveryAtomic: async (input) => {
          expect(input.decision).toEqual(body);
          return {
            outcome: "accepted",
            response: {
              receipt_id: crypto.randomUUID(),
              receipt_status: "succeeded",
            },
          };
        },
      });
      expect(response.status).toBe(202);
    }
    // retry_restore names no turn either: it restores the same pointer.
    expect(
      (
        await decide({
          decision: "retry_restore",
          expected_revision: 1,
          reason: "r",
          target_turn_id: "1",
        })
      ).status,
    ).toBe(400);
  });

  test("maps every refusal to its status and code", async () => {
    const cases: Array<
      [
        Awaited<ReturnType<SessionControl["decideRecoveryAtomic"]>>,
        number,
        ApiErrorCode,
      ]
    > = [
      [{ outcome: "conflict" }, 409, "IDEMPOTENCY_CONFLICT"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
      [
        { outcome: "revision_conflict", currentRevision: 4 },
        409,
        "REVISION_CONFLICT",
      ],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [{ outcome: "execution_unconfirmed" }, 409, "RECOVERY_REQUIRED"],
      [
        { outcome: "turn_not_unknown", turnStatus: "completed" },
        409,
        "REQUEST_STALE",
      ],
      [{ outcome: "turn_not_unknown", turnStatus: null }, 404, "NOT_FOUND"],
      [{ outcome: "unsupported" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "checkpoint_not_covering" }, 409, "CHECKPOINT_UNAVAILABLE"],
      [
        { outcome: "not_in_recovery", admissionState: "active" },
        409,
        "REQUEST_STALE",
      ],
      [{ outcome: "unknown_turn_left", turnId: "2" }, 409, "RECOVERY_REQUIRED"],
      [{ outcome: "workspace_reclaiming" }, 503, "BACKEND_UNAVAILABLE"],
      [
        { outcome: "not_restore_failed", admissionState: "recovery_required" },
        409,
        "REQUEST_STALE",
      ],
    ];
    for (const [result, status, code] of cases) {
      const response = await decide(abandon, {
        decideRecoveryAtomic: async () => result,
      });
      expect(response.status, code).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
  });

  test("a principal without sessions:recover is 403 FORBIDDEN, not 404", async () => {
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
      },
      authorization: {
        authorize: (actor, action, resource) =>
          actor.ownerId === resource.ownerId && action !== "sessions:recover",
      },
      catalog,
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      controls: {
        terminateAtomic: async () => {
          throw new Error("not reached");
        },
        pauseAtomic: async () => {
          throw new Error("not reached");
        },
        decideRecoveryAtomic: async () => {
          throw new Error("must not reach the transaction");
        },
        resumeAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        readEvents: async () => null,
      },
    });
    const scoped = createApiApp({
      authMode: "none",
      registerRoutes: (router) => registerSessionRoutes(router, service),
    });
    const response = await scoped.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(abandon),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });
});

describe("POST /v1/sessions/{id}/resume validation", () => {
  const path = `/v1/sessions/${sessionId}/resume`;
  const resume = (body: unknown, overrides: Partial<SessionControl> = {}) =>
    app(overrides).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(body),
    });

  test("answers 202 with the receipt", async () => {
    const receiptId = crypto.randomUUID();
    const response = await resume(
      { expected_revision: 7 },
      {
        resumeAtomic: async (input) => {
          expect(input).toMatchObject({
            principal: { ownerId: "owner-a" },
            sessionId,
            idempotencyKey: "key-1",
            expectedRevision: 7,
          });
          return {
            outcome: "accepted",
            response: { receipt_id: receiptId, receipt_status: "succeeded" },
          };
        },
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "succeeded",
    });
    expect((await resume({})).status).toBe(400);
    expect(
      (await resume({ expected_revision: 1, reason: "extra" })).status,
    ).toBe(400);
  });

  test("maps every refusal to its status and code", async () => {
    const cases: Array<
      [
        Awaited<ReturnType<SessionControl["resumeAtomic"]>>,
        number,
        ApiErrorCode,
      ]
    > = [
      [
        { outcome: "recovery_required", unconfirmedTurnId: "1" },
        409,
        "RECOVERY_REQUIRED",
      ],
      [
        { outcome: "recovery_required", unconfirmedTurnId: null },
        409,
        "RECOVERY_REQUIRED",
      ],
      [{ outcome: "checkpoint_unavailable" }, 409, "CHECKPOINT_UNAVAILABLE"],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [{ outcome: "rejected", admissionState: "active" }, 409, "REQUEST_STALE"],
      [{ outcome: "pause_committing" }, 409, "PAUSE_COMMITTING"],
      [
        { outcome: "rejected", admissionState: "resuming" },
        409,
        "SESSION_RESUMING",
      ],
      [{ outcome: "unsupported" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "workspace_reclaiming" }, 503, "BACKEND_UNAVAILABLE"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
      [
        { outcome: "revision_conflict", currentRevision: 2 },
        409,
        "REVISION_CONFLICT",
      ],
    ];
    for (const [result, status, code] of cases) {
      const response = await resume(
        { expected_revision: 1 },
        { resumeAtomic: async () => result },
      );
      expect(response.status, code).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
  });

  test("a workspace being reclaimed is worth retrying; the other refusals are not", async () => {
    const refused = async (
      result: Awaited<ReturnType<SessionControl["resumeAtomic"]>>,
    ) => {
      const response = await resume(
        { expected_revision: 1 },
        { resumeAtomic: async () => result },
      );
      return apiErrorResponseSchema.parse(await response.json()).error;
    };

    expect(await refused({ outcome: "workspace_reclaiming" })).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(await refused({ outcome: "checkpoint_unavailable" })).toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
      retryable: false,
    });
  });
});

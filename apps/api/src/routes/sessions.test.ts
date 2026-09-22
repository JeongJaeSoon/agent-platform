import { describe, expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@agent-platform/contracts";
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

const catalog: SessionCatalog = {
  profiles: {
    "claude-coding-v1": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit", "Bash"],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: { kind: "api_key", value: "catalog-provider-key" },
      },
    },
  },
  repositories: {
    "sample-app": { url: "https://example.invalid/app.git", branch: "main" },
  },
};

function app(
  overrides: Partial<SessionUnitOfWork & SessionReader & SessionControl> = {},
) {
  const service = createSessionService({
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

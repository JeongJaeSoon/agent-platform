import { describe, expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@agent-platform/contracts";
import {
  createSessionService,
  ownerScopedPolicy,
  type SessionReader,
  type SessionUnitOfWork,
} from "@agent-platform/platform";
import { createApiApp } from "../app.ts";
import { registerSessionRoutes } from "./sessions.ts";

const catalog = {
  profiles: {
    "claude-coding-v1": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
    },
  },
  repositories: {
    "sample-app": { url: "https://example.invalid/app.git", branch: "main" },
  },
} as const;

function app(overrides: Partial<SessionUnitOfWork & SessionReader> = {}) {
  const service = createSessionService({
    authorization: ownerScopedPolicy,
    catalog,
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      ...overrides,
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      getSession: async () => null,
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

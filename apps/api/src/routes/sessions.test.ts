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
    const response = await post({ ...valid, profile_id: "nope" });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("UNSUPPORTED_CAPABILITY");
    expect((await post({ ...valid, repository_id: "nope" })).status).toBe(422);
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

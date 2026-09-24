import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  readyResponseSchema,
} from "@agent-platform/contracts";
import { createApiApp } from "./app.ts";
import type { ReadinessResult } from "./readiness.ts";

function app(result?: ReadinessResult) {
  return createApiApp({
    authMode: "api-key",
    ...(result ? { readiness: async () => result } : {}),
  });
}

describe("GET /healthz", () => {
  test("answers 200 with a minimal body and no authentication", async () => {
    const response = await app().request("/healthz");
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
    });
  });
});

describe("GET /readyz", () => {
  test("answers 200 with every check ok when the probe passes", async () => {
    const response = await app({ ready: true }).request("/readyz");
    expect(response.status).toBe(200);
    expect(readyResponseSchema.parse(await response.json())).toEqual({
      status: "ready",
      checks: { database: "ok", schema: "ok", config: "ok" },
    });
  });

  test("answers 503 NOT_READY naming the failed check", async () => {
    const response = await app({
      ready: false,
      check: "schema",
      reason: "expected 0004, database has 0003",
    }).request("/readyz");
    expect(response.status).toBe(503);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({
      code: "NOT_READY",
      retryable: true,
      details: { check: "schema" },
    });
    // The reason stays in the log; it may name hosts or files.
    expect(JSON.stringify(body)).not.toContain("0003");
  });

  test("answers 503 when no probe was wired", async () => {
    const response = await app().request("/readyz");
    expect(response.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "NOT_READY",
    );
  });
});

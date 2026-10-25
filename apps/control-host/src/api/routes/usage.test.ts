import { expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createUsageService,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerUsageRoutes } from "./usage.ts";

const createApiApp = recordRouteErrors("routes/usage.test.ts");

const app = createApiApp({
  authMode: "none",
  registerRoutes: (router) =>
    registerUsageRoutes(
      router,
      createUsageService({
        authorization: createAuthorizationPolicy(),
        limits: {
          executionSlotLimit: 1,
          queuedInputLimitPerSession: 3,
          storageLimitBytes: 1e15,
          maxTurnSeconds: 60,
          sessionCostLimitUsd: 1,
          sessionTokenLimit: null,
          providerMaxRetries: 0,
        },
        reader: {
          installationUsage: async () => ({
            readAt: new Date("2026-09-26T00:00:00.000Z"),
            executionSlotsUsed: 0,
            queuedInputCount: 0,
            storageUsedBytes: 0,
            storageUpdatedAt: null,
          }),
          sessionUsage: async () => null,
          usageSummary: async () => {
            throw new Error("not read in these tests");
          },
          usageTools: async () => {
            throw new Error("not read in these tests");
          },
        },
      }),
    ),
});

const headers = { "X-Owner-Id": "owner-a" };

// AUTH_MODE=none lets anyone name an owner, so nobody is the installation's
// owner and nobody started a session of their own.
test("refuses installation figures and a summary of one's own sessions under AUTH_MODE=none", async () => {
  for (const path of [
    "/v1/limits",
    "/v1/usage/summary?scope=installation&since=2026-10-01",
    "/v1/usage/summary?scope=me&since=2026-10-01",
    "/v1/usage/tools?scope=installation&since=2026-10-01",
    "/v1/usage/tools?scope=me&since=2026-10-01",
  ]) {
    const response = await app.request(path, { headers });
    expect(response.status, path).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "FORBIDDEN",
    );
  }
});

test("answers 400 for a summary query it cannot read", async () => {
  for (const query of [
    "scope=me",
    "scope=team&since=2026-10-01",
    "scope=me&since=2026-10-01T00:00:00",
    "scope=me&since=2026-10-02&until=2026-10-01",
  ]) {
    const response = await app.request(`/v1/usage/summary?${query}`, {
      headers,
    });
    expect(response.status, query).toBe(400);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "BAD_REQUEST",
    );
  }
});

test("answers 400 for a tools query it cannot read", async () => {
  for (const query of [
    "scope=me",
    "scope=me&since=2026-10-02&until=2026-10-01",
    "scope=me&since=2026-10-01&agent_id=not-a-uuid",
  ]) {
    const response = await app.request(`/v1/usage/tools?${query}`, {
      headers,
    });
    expect(response.status, query).toBe(400);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "BAD_REQUEST",
    );
  }
});

test("answers 404 for an unknown or malformed session id", async () => {
  for (const id of ["0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d", "not-a-uuid"]) {
    const response = await app.request(`/v1/sessions/${id}/usage`, {
      headers,
    });
    expect(response.status, id).toBe(404);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "NOT_FOUND",
    );
  }
});

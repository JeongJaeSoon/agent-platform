import { expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  installationLimitsResponseSchema,
} from "@agent-platform/contracts";
import { allowAllPolicy, createUsageService } from "@agent-platform/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerUsageRoutes } from "./usage.ts";

const createApiApp = recordRouteErrors("usage.test.ts");

const app = createApiApp({
  authMode: "none",
  registerRoutes: (router) =>
    registerUsageRoutes(
      router,
      createUsageService({
        authorization: allowAllPolicy,
        limits: {
          executionSlotLimit: 1,
          queuedInputLimitPerSession: 3,
          storageLimitBytes: 1e15,
          maxTurnSeconds: 60,
          sessionCostLimitUsd: 1,
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
        },
      }),
    ),
});

const headers = { "X-Owner-Id": "owner-a" };

test("serves the installation limits", async () => {
  const response = await app.request("/v1/limits", { headers });
  expect(response.status).toBe(200);
  expect(
    installationLimitsResponseSchema.safeParse(await response.json()).success,
  ).toBe(true);
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

import {
  installationLimitsResponseSchema,
  sessionIdParamsSchema,
  sessionUsageResponseSchema,
} from "@agent-platform/contracts";
import type { UsageService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema } from "../app.ts";
import { mapped, requireParams } from "./sessions.ts";

// Error statuses each handler can produce; the OpenAPI parity test holds the
// route table to this.
export const usageRouteErrors: Record<string, number[]> = {
  "GET /v1/limits": [401, 503],
  "GET /v1/sessions/{id}/usage": [401, 404, 503],
};

export function registerUsageRoutes(router: ApiRouter, service: UsageService) {
  router.get("/limits", async (context) => {
    const limits = await mapped(() => service.getInstallationLimits());
    return jsonWithSchema(context, installationLimitsResponseSchema, limits);
  });

  router.get("/sessions/:id/usage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const usage = await mapped(() =>
      service.getSessionUsage({ ownerId: context.get("ownerId") }, params.id),
    );
    return jsonWithSchema(context, sessionUsageResponseSchema, usage);
  });
}

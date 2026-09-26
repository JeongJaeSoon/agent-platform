import {
  installationLimitsResponseSchema,
  sessionIdParamsSchema,
  sessionUsageResponseSchema,
} from "@agent-platform/contracts";
import type { UsageService } from "@agent-platform/platform";
import { type ApiRouter, jsonWithSchema } from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

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

import {
  installationLimitsResponseSchema,
  sessionIdParamsSchema,
  sessionUsageResponseSchema,
} from "@agent-platform/contracts";
import type { UsageService } from "@agent-platform/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerUsageRoutes(router: ApiRouter, service: UsageService) {
  apiRoute(router, "getInstallationLimits", async (context) => {
    const limits = await mapped(() => service.getInstallationLimits());
    return jsonWithSchema(context, installationLimitsResponseSchema, limits);
  });

  apiRoute(router, "getSessionUsage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const usage = await mapped(() =>
      service.getSessionUsage({ ownerId: context.get("ownerId") }, params.id),
    );
    return jsonWithSchema(context, sessionUsageResponseSchema, usage);
  });
}

import {
  installationLimitsResponseSchema,
  sessionIdParamsSchema,
  sessionUsageResponseSchema,
  usageSummaryQuerySchema,
  usageSummaryResponseSchema,
} from "@werft-ai/contracts";
import type { UsageService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../app.ts";
import { mapped, requireParams, requireQuery } from "./errors.ts";

export function registerUsageRoutes(router: ApiRouter, service: UsageService) {
  apiRoute(router, "getInstallationLimits", async (context) => {
    const limits = await mapped(() =>
      service.getInstallationLimits(context.get("caller")),
    );
    return jsonWithSchema(context, installationLimitsResponseSchema, limits);
  });

  apiRoute(router, "getUsageSummary", async (context) => {
    const query = requireQuery(context, usageSummaryQuerySchema);
    const summary = await mapped(() =>
      service.getUsageSummary(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageSummaryResponseSchema, summary);
  });

  apiRoute(router, "getSessionUsage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const usage = await mapped(() =>
      service.getSessionUsage(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, sessionUsageResponseSchema, usage);
  });
}

import {
  installationLimitsResponseSchema,
  sessionIdParamsSchema,
  sessionUsageResponseSchema,
  usageBreakdownQuerySchema,
  usageBreakdownResponseSchema,
  usageSeriesQuerySchema,
  usageSeriesResponseSchema,
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

  apiRoute(router, "getUsageSeries", async (context) => {
    const query = requireQuery(context, usageSeriesQuerySchema);
    const series = await mapped(() =>
      service.getUsageSeries(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageSeriesResponseSchema, series);
  });

  apiRoute(router, "getUsageBreakdown", async (context) => {
    const query = requireQuery(context, usageBreakdownQuerySchema);
    const breakdown = await mapped(() =>
      service.getUsageBreakdown(context.get("caller"), query),
    );
    return jsonWithSchema(context, usageBreakdownResponseSchema, breakdown);
  });

  apiRoute(router, "getSessionUsage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const usage = await mapped(() =>
      service.getSessionUsage(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, sessionUsageResponseSchema, usage);
  });
}

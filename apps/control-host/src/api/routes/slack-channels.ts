import {
  agentIdParamsSchema,
  searchSlackChannelsQuerySchema,
  searchSlackChannelsResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackChannelSearchService } from "@werft-ai/platform";
import { type ApiRouter, apiRoute, jsonWithSchema } from "../app.ts";
import { mapped, requireParams, requireQuery } from "./errors.ts";

export function registerSlackChannelRoutes(
  router: ApiRouter,
  deps: { service: SlackChannelSearchService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "searchSlackChannels", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const query = requireQuery(context, searchSlackChannelsQuerySchema);
    const found = await mapped(() =>
      service.searchSlackChannels(context.get("caller"), params.id, query),
    );
    logger?.info("Slack channels searched", {
      agent_id: params.id,
      slack_app_id: found.slackAppId,
      cache: found.cache,
      count: found.page.items.length,
    });
    return jsonWithSchema(
      context,
      searchSlackChannelsResponseSchema,
      found.page,
    );
  });
}

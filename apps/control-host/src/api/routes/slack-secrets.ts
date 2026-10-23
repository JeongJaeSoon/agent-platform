import {
  deleteSlackSecretResponseSchema,
  putSlackSecretRequestSchema,
  putSlackSecretResponseSchema,
  slackSecretSummarySchema,
  workspaceParamsSchema,
} from "@werft-ai/contracts";
import type { SlackSecretService } from "@werft-ai/platform";
import type { Context } from "hono";
import {
  type ApiEnvironment,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

function lowercaseWorkspaceId(context: Context<ApiEnvironment>): string {
  return requireParams(context, workspaceParamsSchema).id.toLowerCase();
}

export function registerSlackSecretRoutes(
  router: ApiRouter,
  service: SlackSecretService,
) {
  apiRoute(router, "getSlackConfigToken", async (context) => {
    const summary = await mapped(() =>
      service.describeConfigToken(
        context.get("caller"),
        lowercaseWorkspaceId(context),
      ),
    );
    return jsonWithSchema(context, slackSecretSummarySchema, summary);
  });

  apiRoute(router, "putSlackConfigToken", async (context) => {
    const set = await mapped(() =>
      service.setConfigToken(
        context.get("caller"),
        lowercaseWorkspaceId(context),
        async () =>
          (await parseJsonBody(context, putSlackSecretRequestSchema)).value,
      ),
    );
    return jsonWithSchema(context, putSlackSecretResponseSchema, set);
  });

  apiRoute(router, "deleteSlackConfigToken", async (context) => {
    const deleted = await mapped(() =>
      service.deleteConfigToken(
        context.get("caller"),
        lowercaseWorkspaceId(context),
      ),
    );
    return jsonWithSchema(context, deleteSlackSecretResponseSchema, deleted);
  });
}

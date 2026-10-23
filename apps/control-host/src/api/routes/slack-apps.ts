import {
  agentIdParamsSchema,
  createSlackAppRequestSchema,
  createSlackAppResponseSchema,
  deleteSlackAppResponseSchema,
  getSlackAppResponseSchema,
  putSlackSecretRequestSchema,
  putSlackSecretResponseSchema,
  slackAppParamsSchema,
  slackAppSecretParamsSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackAppService, SlackSecretService } from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerSlackAppRoutes(
  router: ApiRouter,
  deps: {
    apps: SlackAppService;
    secrets: SlackSecretService;
    logger?: StructuredLogger;
  },
) {
  const { apps, secrets, logger } = deps;

  apiRoute(router, "getSlackApp", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const found = await mapped(() =>
      apps.getAgentApp(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSlackAppResponseSchema, found);
  });

  apiRoute(router, "createSlackApp", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, createSlackAppRequestSchema);
    const created = await mapped(() =>
      apps.createAgentApp(context.get("caller"), params.id, body),
    );
    // Ids only: the create answer's secrets never leave the service.
    logger?.info("Slack app created", {
      agent_id: params.id,
      slack_app_id: created.slack_app.id,
      app_id: created.slack_app.app_id,
      created: created.created,
    });
    return jsonWithSchema(context, createSlackAppResponseSchema, created);
  });

  apiRoute(router, "deleteSlackApp", async (context) => {
    const params = requireParams(context, slackAppParamsSchema);
    const deleted = await mapped(() =>
      apps.deleteApp(
        context.get("caller"),
        params.id.toLowerCase(),
        params.app_id.toLowerCase(),
      ),
    );
    logger?.info("Slack app deleted", {
      slack_app_id: deleted.slack_app.id,
      app_id: deleted.slack_app.app_id,
      state: deleted.slack_app.state,
    });
    return jsonWithSchema(context, deleteSlackAppResponseSchema, deleted);
  });

  apiRoute(router, "putSlackAppSecret", async (context) => {
    // 400, not the usual 404: a purpose outside the app's three (the config
    // token above all) is a malformed request, refused before any lookup.
    const parsed = slackAppSecretParamsSchema.safeParse(context.req.param());
    if (!parsed.success) {
      throw new ApiHttpError(
        400,
        "BAD_REQUEST",
        "The app id must be a UUID and the purpose one of slack_signing_secret, slack_client_secret, slack_bot_token",
      );
    }
    const params = parsed.data;
    const set = await mapped(() =>
      secrets.setAppSecret(
        context.get("caller"),
        params.id.toLowerCase(),
        params.app_id.toLowerCase(),
        params.purpose,
        async () =>
          (await parseJsonBody(context, putSlackSecretRequestSchema)).value,
      ),
    );
    return jsonWithSchema(context, putSlackSecretResponseSchema, set);
  });
}

import {
  agentIdParamsSchema,
  completeSlackInstallRequestSchema,
  completeSlackInstallResponseSchema,
  startSlackInstallResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SlackInstallService } from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

// The state, the code and the bot token are never logged: only ids and the
// outcome are.
export function registerSlackInstallRoutes(
  router: ApiRouter,
  deps: { service: SlackInstallService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "startSlackInstall", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const started = await mapped(() =>
      service.start(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, startSlackInstallResponseSchema, started);
  });

  apiRoute(
    router,
    "completeSlackInstall",
    // The callback page's URL held the code; nothing this answers may pass
    // it on, errors included.
    async (context, next) => {
      await next();
      context.res.headers.set("Referrer-Policy", "no-referrer");
    },
    async (context) => {
      const body = await parseJsonBody(
        context,
        completeSlackInstallRequestSchema,
      );
      const completed = await mapped(() =>
        service.complete(context.get("caller"), body),
      ).catch((error: unknown) => {
        if (error instanceof ApiHttpError) {
          // The details hold only codes, methods and statuses.
          logger?.warn("Slack install failed", {
            agent_id: body.agent_id,
            status: error.status,
            code: error.code,
            ...(typeof error.details === "object" ? error.details : {}),
          });
        }
        throw error;
      });
      logger?.info("Slack app installed", {
        agent_id: completed.slack_app.agent_id,
        slack_app_id: completed.slack_app.id,
        app_id: completed.installation.app_id,
        team_id: completed.installation.team_id,
        installation_id: completed.installation.id,
        identity_id: completed.agent_identity.id,
        finalized: completed.finalized,
        // `reinstall_required` is kept nowhere else yet (94S-793 decides).
        warnings: completed.warnings.map((warning) => warning.code),
      });
      return jsonWithSchema(
        context,
        completeSlackInstallResponseSchema,
        completed,
      );
    },
  );
}

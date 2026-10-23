import {
  agentIdParamsSchema,
  listSlackBindingsResponseSchema,
  putSlackBindingRequestSchema,
  putSlackBindingResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type { SurfaceBindingService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";

export function registerSlackBindingRoutes(
  router: ApiRouter,
  deps: { service: SurfaceBindingService; logger?: StructuredLogger },
) {
  const { service, logger } = deps;

  apiRoute(router, "listSlackBindings", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const page = await mapped(() =>
      service.listSlackBindings(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, listSlackBindingsResponseSchema, page);
  });

  apiRoute(router, "putSlackBinding", async (context) => {
    const params = requireParams(context, agentIdParamsSchema);
    const body = await parseJsonBody(context, putSlackBindingRequestSchema);
    const set = await mapped(() =>
      service.putSlackBinding(context.get("caller"), params.id, body),
    );
    logger?.info("Slack binding set", {
      agent_id: params.id,
      surface_binding_id: set.slack_binding.id,
      channel_id: set.slack_binding.external_surface_id,
      mode: set.slack_binding.mode,
      home: set.slack_binding.home,
    });
    return jsonWithSchema(context, putSlackBindingResponseSchema, set);
  });
}

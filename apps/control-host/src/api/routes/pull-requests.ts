import {
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  openPullRequestRequestSchema,
  openPullRequestResponseSchema,
  pushRequestParamsSchema,
} from "@agent-platform/contracts";
import type { PullRequestService } from "@agent-platform/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { mapped, requireParams } from "./errors.ts";
import { actorOf } from "./push-requests.ts";

export function registerPullRequestRoutes(
  router: ApiRouter,
  service: PullRequestService,
) {
  apiRoute(router, "openPullRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const opened = await mapped(() =>
      service.open(actorOf(context), params.id, params.push_request_id, {
        readBody: () => parseJsonBody(context, openPullRequestRequestSchema),
      }),
    );
    return jsonWithSchema(
      context,
      openPullRequestResponseSchema,
      opened,
      opened.created ? 201 : 200,
    );
  });

  apiRoute(router, "commentPullRequest", async (context) => {
    const params = requireParams(context, pushRequestParamsSchema);
    const commented = await mapped(() =>
      service.comment(actorOf(context), params.id, params.push_request_id, {
        readBody: () => parseJsonBody(context, commentPullRequestRequestSchema),
      }),
    );
    return jsonWithSchema(
      context,
      commentPullRequestResponseSchema,
      commented,
      commented.comment.created ? 201 : 200,
    );
  });
}

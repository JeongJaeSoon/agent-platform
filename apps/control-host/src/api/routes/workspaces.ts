import {
  auditRetentionRequestSchema,
  auditRetentionResponseSchema,
  workspaceParamsSchema,
} from "@agent-platform/contracts";
import type {
  AuditRetentionStore,
  AuthorizationPolicy,
} from "@agent-platform/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import { requireParams } from "./errors.ts";

export interface WorkspaceRouteDeps {
  authorization: AuthorizationPolicy;
  retention: AuditRetentionStore;
}

export function registerWorkspaceRoutes(
  router: ApiRouter,
  deps: WorkspaceRouteDeps,
) {
  apiRoute(router, "setAuditRetention", async (context) => {
    const caller = context.get("caller");
    const principal = context.get("principal");
    const params = requireParams(context, workspaceParamsSchema);
    // Principals carry lowercase ids, and the policy compares strings.
    const workspaceId = params.id.toLowerCase();
    // Asked before the body is read, so a refused caller learns nothing
    // about the request shape and every attempt leaves a decision row.
    const decision = await deps.authorization.authorize({
      subject: caller.subject,
      action: "audit_retention.manage",
      resource: {
        kind: "workspace",
        id: workspaceId,
        owner_scope: workspaceId,
      },
      request_id: caller.requestId,
    });
    if (decision.reason_code === "not_found") {
      throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
    }
    // The policy already holds this to owners; the principal check keeps
    // the store's ownerUserId a person's.
    if (
      decision.outcome !== "allow" ||
      principal.kind !== "user" ||
      principal.role !== "owner"
    ) {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "Only an owner can change audit retention",
      );
    }
    const body = await parseJsonBody(context, auditRetentionRequestSchema);
    if (
      !(await deps.retention.setAuditRetentionDays({
        workspaceId,
        ownerUserId: principal.id,
        days: body.audit_retention_days,
      }))
    ) {
      throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
    }
    return jsonWithSchema(context, auditRetentionResponseSchema, body);
  });
}

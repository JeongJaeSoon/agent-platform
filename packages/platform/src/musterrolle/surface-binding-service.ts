import {
  DEFAULT_SURFACE_CEILING,
  type ListSlackBindingsResponse,
  type PutSlackBindingRequest,
  type PutSlackBindingResponse,
  SLACK_BINDING_LIST_LIMIT,
  SLACK_BINDING_MESSAGES,
  type SurfaceBinding,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "../ports/surface-binding-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";

// Design 4.1's "Slack 앱 설치·채널 설정" row: `binding.manage` on the
// agent, which owner, admin and that agent's admins hold.
const ACTION = "binding.manage";
const MANAGERS: readonly WorkspaceRole[] = MANAGEMENT_ROLES[ACTION] ?? [];

export function surfaceBindingView(
  record: SurfaceBindingRecord,
): SurfaceBinding {
  return {
    id: record.id,
    workspace_id: record.workspaceId,
    owner_id: record.workspaceId,
    surface: "slack",
    installation_id: record.installationId,
    external_surface_id: record.channelId,
    surface_kind: record.channelKind,
    agent_id: record.agentId,
    mode: record.mode,
    ceiling: record.ceiling,
    home: record.home,
    memory_write_policy: record.memoryWritePolicy,
    status: record.status,
    muted: record.muted,
    revision: record.revision,
    created_at: record.createdAt.toISOString(),
    revoked_at: record.revokedAt?.toISOString() ?? null,
  };
}

export function createSurfaceBindingService(deps: {
  authorization: AuthorizationPolicy;
  store: SurfaceBindingStore;
}) {
  const { authorization, store } = deps;

  const permitted = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, ACTION, {
      kind: "agent",
      id: agentId,
    });

  return {
    async putSlackBinding(
      caller: Caller,
      agentId: string,
      request: PutSlackBindingRequest,
    ): Promise<PutSlackBindingResponse> {
      await permitted(caller, agentId);
      const result = await store.set({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        channelId: request.channel_id,
        channelKind: request.channel_kind,
        mode: request.mode,
        home: request.home,
        ceiling: request.ceiling ?? DEFAULT_SURFACE_CEILING,
        managerRoles: MANAGERS,
      });
      switch (result.outcome) {
        case "set":
          return {
            slack_binding: surfaceBindingView(result.binding),
            receipt_id: result.receiptId,
          };
        case "agent_not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "not_installed":
          throw new SessionServiceError(
            "SLACK_NOT_INSTALLED",
            SLACK_BINDING_MESSAGES.notInstalled,
          );
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            SLACK_BINDING_MESSAGES.conflict,
          );
        case "outranked":
          throw new SessionServiceError(
            "FORBIDDEN",
            "The caller no longer holds this right",
            undefined,
            { reason_code: "role" },
          );
        default:
          throw new SessionServiceError(
            "FORBIDDEN",
            "This principal is no longer a member of the workspace",
          );
      }
    },

    async listSlackBindings(
      caller: Caller,
      agentId: string,
    ): Promise<ListSlackBindingsResponse> {
      await permitted(caller, agentId);
      const rows = await store.list(
        caller.ownerId,
        agentId,
        SLACK_BINDING_LIST_LIMIT,
      );
      return { items: rows.map(surfaceBindingView) };
    },
  };
}

export type SurfaceBindingService = ReturnType<
  typeof createSurfaceBindingService
>;

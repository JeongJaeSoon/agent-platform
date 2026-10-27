import type {
  CreateWorkspaceProfileRequest,
  ListProfilesResponse,
  ProfileSummary,
  WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { NOT_FOUND } from "../musterrolle/service-errors.ts";
import type { TeamActor } from "../ports/team-store.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  type CatalogProfileView,
  isUnmetered,
  narrowedProfile,
  narrowingRefusal,
  profileFingerprint,
  profileModels,
  repositoryModeOf,
  type SessionCatalogView,
  type WorkspaceProfileRecord,
  type WorkspaceProfiles,
  workspaceProfileState,
} from "./catalog.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

/**
 * How often a process reads the versions again on its own, for the lookups
 * that do not read them first (a session's runtime in a list, for one).
 */
export const WORKSPACE_PROFILE_REFRESH_MS = 10_000;

/**
 * The versions in `store`, read again on `refresh`. A refresh joins a read
 * that began recently enough, else starts one; a failed read keeps what was
 * read before.
 */
export function createWorkspaceProfiles(
  store: Pick<WorkspaceProfileStore, "listAll">,
  now: () => number = Date.now,
): WorkspaceProfiles {
  let records: ReadonlyMap<string, WorkspaceProfileRecord> = new Map();
  let readAt = Number.NEGATIVE_INFINITY;
  let begun = 0;
  let applied = 0;
  let latest: { startedAt: number; done: Promise<void> } | null = null;
  return {
    get records() {
      return records;
    },
    refresh(maxAgeMs = 0) {
      const oldest = now() - maxAgeMs;
      if (maxAgeMs > 0 && readAt >= oldest) return Promise.resolve();
      if (latest !== null && latest.startedAt > oldest) return latest.done;
      const startedAt = now();
      begun += 1;
      const order = begun;
      const done = store.listAll().then(
        (rows) => {
          if (order < applied) return;
          records = new Map(rows.map((row) => [row.id, row]));
          applied = order;
          readAt = startedAt;
        },
        (error: unknown) => {
          if (latest?.done === done) latest = null;
          throw error;
        },
      );
      latest = { startedAt, done };
      return done;
    },
  };
}

/** `trustedId` is the operator profile a repository's allow list names. */
function summaryOf(
  catalog: SessionCatalogView,
  id: string,
  trustedId: string,
  profile: CatalogProfileView,
) {
  return {
    id,
    model: profile.model,
    models: profileModels(profile),
    tools: [...profile.tools],
    permission_mode: profile.permission_mode,
    runtime_kind: profile.runtime_kind,
    runtime_version: profile.runtime_version,
    billing: isUnmetered(profile) ? ("none" as const) : ("metered" as const),
    repository_mode: repositoryModeOf(profile),
    repository_ids:
      repositoryModeOf(profile) === "none"
        ? []
        : Object.entries(catalog.repositories)
            .filter(([, repository]) => repository.profiles.includes(trustedId))
            .map(([repositoryId]) => repositoryId)
            .sort(),
  };
}

function workspaceSummary(
  catalog: SessionCatalogView,
  record: WorkspaceProfileRecord,
): ProfileSummary {
  const base = Object.hasOwn(catalog.profiles, record.base_profile_id)
    ? catalog.profiles[record.base_profile_id]
    : undefined;
  return {
    ...(base
      ? summaryOf(
          catalog,
          record.id,
          record.base_profile_id,
          narrowedProfile(base, record),
        )
      : {
          id: record.id,
          model: record.model,
          models: [
            record.model,
            ...record.models.filter((m) => m !== record.model),
          ],
          tools: [...record.tools],
          permission_mode: record.permission_mode,
          runtime_kind: "claude_agent_sdk" as const,
          runtime_version: record.base_runtime_version,
          billing: record.base_billing,
          repository_mode: record.base_repository_mode,
          repository_ids: [],
        }),
    source: "workspace",
    workspace: {
      name: record.name,
      version: record.version,
      base_profile_id: record.base_profile_id,
      state: workspaceProfileState(catalog, record),
      created_at: record.created_at.toISOString(),
      retired_at: record.retired_at?.toISOString() ?? null,
    },
  };
}

/** Picked field by field: a profile also holds its provider credential. */
export function listCatalogProfiles(
  catalog: SessionCatalogView,
  workspaceId: string | null,
): ListProfilesResponse {
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const operator = Object.entries(catalog.profiles).map(
    ([id, profile]): ProfileSummary => ({
      ...summaryOf(catalog, id, id, profile),
      source: "operator",
    }),
  );
  const workspace =
    workspaceId === null
      ? []
      : [...(catalog.workspace_profiles?.records.values() ?? [])]
          .filter((record) => record.workspace_id === workspaceId)
          .map((record) => workspaceSummary(catalog, record));
  return { items: [...operator.sort(byId), ...workspace.sort(byId)] };
}

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds workspace.manage",
    undefined,
    { reason_code: "role" },
  );

export function createWorkspaceProfileService(deps: {
  authorization: AuthorizationPolicy;
  store: WorkspaceProfileStore;
  catalog: SessionCatalogView & { workspace_profiles: WorkspaceProfiles };
  newId?: () => string;
}) {
  const { authorization, store, catalog } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function manager(caller: Caller): Promise<TeamActor> {
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person changes a workspace profile",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  function changed(
    record: WorkspaceProfileRecord,
    receiptId: string | null,
  ): WorkspaceProfileChangeResponse {
    return {
      profile: workspaceSummary(catalog, record),
      receipt_id: receiptId,
    };
  }

  // After a write has committed, a failed read must not report it failed:
  // the answer comes from the written row, and a retry would save again.
  async function reread(): Promise<void> {
    await catalog.workspace_profiles.refresh().catch(() => undefined);
  }

  return {
    async list(caller: Caller): Promise<ListProfilesResponse> {
      await reread();
      return listCatalogProfiles(catalog, caller.actor?.workspaceId ?? null);
    },

    async create(
      caller: Caller,
      request: CreateWorkspaceProfileRequest,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await manager(caller);
      const base = Object.hasOwn(catalog.profiles, request.base_profile_id)
        ? catalog.profiles[request.base_profile_id]
        : undefined;
      if (!base) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          `Unknown operator profile ${request.base_profile_id}`,
          undefined,
          { reason_code: "unknown_base", field: "base_profile_id" },
        );
      }
      const narrowing = {
        model: request.model,
        models: [...new Set(request.models)],
        tools: [...new Set(request.tools)],
        permission_mode: request.permission_mode,
      };
      const refusal = narrowingRefusal(base, narrowing);
      if (refusal !== null) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          refusal.message,
          undefined,
          {
            reason_code: "widens_base",
            field: refusal.field,
          },
        );
      }
      const receiptId = newId();
      const result = await store.create({
        actor,
        receiptId,
        name: request.name,
        baseProfileId: request.base_profile_id,
        base: {
          fingerprint: profileFingerprint(base),
          runtimeVersion: base.runtime_version,
          billing: isUnmetered(base) ? "none" : "metered",
          repositoryMode: repositoryModeOf(base),
        },
        narrowing,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "version_taken":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `Another version of ${request.name} was saved at the same time; save again to make the next one`,
          );
        default:
          await reread();
          return changed(result.record, receiptId);
      }
    },

    async retire(
      caller: Caller,
      profileId: string,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await manager(caller);
      const receiptId = newId();
      const result = await store.retire({ actor, receiptId, profileId });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw OUTRANKED();
        default:
          await reread();
          return changed(
            result.record,
            result.outcome === "retired" ? receiptId : null,
          );
      }
    },
  };
}

export type WorkspaceProfileService = ReturnType<
  typeof createWorkspaceProfileService
>;

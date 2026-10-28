import {
  type CreateWorkspaceProfileRequest,
  type ListProfilesResponse,
  type ProfileDerivationPolicy,
  type ProfileSummary,
  WORKSPACE_PROFILE_POLICY,
  type WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { NOT_FOUND } from "../musterrolle/service-errors.ts";
import type { TeamActor } from "../ports/team-store.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  type CatalogProfileView,
  derivationPolicyOf,
  isUnmetered,
  profileAllowsRepository,
  profileFingerprint,
  profileModels,
  refreshWorkspaceProfilesFor,
  repositoryModeOf,
  type SessionCatalogView,
  sessionCatalogView,
  type WorkspaceProfileRecord,
  type WorkspaceProfiles,
  workspaceProfileState,
} from "./catalog.ts";
import { latestReads } from "./profile-registry.ts";
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
  policy: ProfileDerivationPolicy = WORKSPACE_PROFILE_POLICY,
): WorkspaceProfiles {
  let records: ReadonlyMap<string, WorkspaceProfileRecord> = new Map();
  return {
    policy,
    get records() {
      return records;
    },
    refresh: latestReads(
      () => store.listAll(),
      (rows) => {
        records = new Map(rows.map((row) => [row.id, row]));
      },
      now,
    ),
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
            .filter(([repositoryId, repository]) =>
              profileAllowsRepository(
                catalog,
                trustedId,
                repositoryId,
                repository,
              ),
            )
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
          derivationPolicyOf(catalog).apply(base, record),
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
      created_by: record.created_by,
      created_at: record.created_at.toISOString(),
      retired_by: record.retired_by,
      retired_at: record.retired_at?.toISOString() ?? null,
    },
  };
}

/**
 * An installation ceiling as listed, whatever its state: one that does not
 * run here is described from its stored definition. Undefined for an id
 * with neither (a row that no longer parses).
 */
export function operatorSummary(
  catalog: SessionCatalogView,
  id: string,
): ProfileSummary | undefined {
  const entry = catalog.installation?.get(id);
  const profile = Object.hasOwn(catalog.profiles, id)
    ? catalog.profiles[id]
    : entry?.definition &&
      sessionCatalogView({
        profiles: { [id]: entry.definition },
        repositories: {},
      }).profiles[id];
  if (!profile) return undefined;
  const record = entry?.record;
  return {
    ...summaryOf(catalog, id, id, profile),
    source: "operator",
    ...(entry && record
      ? {
          installation: {
            name: record.name,
            version: record.version,
            origin: record.origin,
            state: entry.state,
            connection_id: entry.connection_id ?? null,
            title_model: profile.title_model ?? null,
            project_settings: profile.project_settings ?? {
              claude_md: false,
            },
            previous_id: record.previous_id,
            created_by: record.created_by,
            created_at: record.created_at.toISOString(),
            retired_by: record.retired_by,
            retired_at: record.retired_at?.toISOString() ?? null,
          },
        }
      : {}),
  };
}

/** Picked field by field: a profile also holds its provider credential. */
export function listCatalogProfiles(
  catalog: SessionCatalogView,
  workspaceId: string | null,
): ListProfilesResponse {
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const operator = [
    ...new Set([
      ...Object.keys(catalog.profiles),
      ...(catalog.installation?.keys() ?? []),
    ]),
  ].flatMap((id) => {
    const summary = operatorSummary(catalog, id);
    return summary ? [summary] : [];
  });
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
      await refreshWorkspaceProfilesFor(catalog, [request.base_profile_id], {
        strict: true,
      });
      const base = Object.hasOwn(catalog.profiles, request.base_profile_id)
        ? catalog.profiles[request.base_profile_id]
        : undefined;
      const baseState = catalog.installation?.get(
        request.base_profile_id,
      )?.state;
      if (baseState !== undefined && baseState !== "usable") {
        throw new SessionServiceError(
          "BAD_REQUEST",
          baseState === "retired"
            ? `Operator profile ${request.base_profile_id} is retired: pick a newer version`
            : `Operator profile ${request.base_profile_id} does not run here (${baseState}): pick a usable one`,
          undefined,
          { reason_code: baseState, field: "base_profile_id" },
        );
      }
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
      const refusal = derivationPolicyOf(catalog).refusal(base, narrowing);
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

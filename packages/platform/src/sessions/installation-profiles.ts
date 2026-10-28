import {
  type CreateInstallationProfileRequest,
  type InstallationProfileOptionsResponse,
  OPT_IN_PERMISSION_MODES,
  PERMISSION_MODE_VALUES,
  type ProfileSummary,
  RUNTIME_KIND_VALUES,
  type WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { NOT_FOUND } from "../musterrolle/service-errors.ts";
import type {
  InstallationProfileRecord,
  InstallationProfileStore,
} from "../ports/installation-profile-store.ts";
import type { TeamActor } from "../ports/team-store.ts";
import {
  type CatalogProfileConfig,
  catalogProfileConfigSchema,
  describeConfigError,
  type SessionCatalogView,
  type WorkspaceProfiles,
} from "./catalog.ts";
import type { ProfileFeatureGate } from "./feature-gate.ts";
import { type Connections, definitionFingerprint } from "./profile-registry.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";
import { operatorSummary } from "./workspace-profiles.ts";

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds profile.installation.manage",
    undefined,
    { reason_code: "role" },
  );

const badRequest = (message: string, reason_code: string, field?: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code,
    ...(field === undefined ? {} : { field }),
  });

/**
 * Installation ceilings made and retired in the console
 * (docs/contributing/decisions/profile-db.md §6). Only the operator, a
 * signed-in owner, writes one; what a ceiling may name (a connection, an
 * installed runtime, a repository, the unattended switch) stays the
 * installation's.
 */
export function createInstallationProfileService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<InstallationProfileStore, "create" | "retire">;
  catalog: SessionCatalogView & { workspace_profiles: WorkspaceProfiles };
  connections: Connections;
  allowUnattended: boolean;
  runtimes: ProfileFeatureGate;
  newId?: () => string;
}) {
  const { authorization, store, catalog, connections, runtimes } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function operator(caller: Caller): Promise<TeamActor> {
    await requirePermitted(
      authorization,
      caller,
      "profile.installation.manage",
      {
        kind: "workspace",
        id: caller.ownerId,
      },
    );
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person changes an installation profile",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  // After a write has committed, a failed read must not report it failed.
  async function reread(): Promise<void> {
    await catalog.workspace_profiles.refresh().catch(() => undefined);
  }

  function changed(
    record: InstallationProfileRecord,
    receiptId: string | null,
    connectionId: string | null = null,
  ): WorkspaceProfileChangeResponse {
    const profile: ProfileSummary | undefined = operatorSummary(
      catalog,
      record.id,
      { record, connectionId },
    );
    if (!profile) {
      throw new Error(`installation profile ${record.id} did not list`);
    }
    return { profile, receipt_id: receiptId };
  }

  function modesOf(kind: CatalogProfileConfig["runtime_kind"]) {
    return PERMISSION_MODE_VALUES.filter(
      (mode) => runtimes.refusal(kind, { permission_mode: mode }) === null,
    );
  }

  function definitionOf(
    request: CreateInstallationProfileRequest,
  ): CatalogProfileConfig {
    if (!Object.hasOwn(connections, request.connection_id)) {
      throw badRequest(
        `Unknown connection ${request.connection_id}`,
        "unknown_connection",
        "connection_id",
      );
    }
    if (!request.models.includes(request.model)) {
      throw badRequest(
        "model must be one of models",
        "model_not_in_models",
        "model",
      );
    }
    const parsed = catalogProfileConfigSchema.safeParse({
      runtime_kind: request.runtime_kind,
      runtime_version: request.runtime_version,
      model: request.model,
      models: [...new Set(request.models)],
      ...(request.title_model === undefined
        ? {}
        : { title_model: request.title_model }),
      tools: [...new Set(request.tools)],
      permission_mode: request.permission_mode,
      provider: connections[request.connection_id],
      ...(request.project_settings === undefined
        ? {}
        : { project_settings: request.project_settings }),
      ...(request.repository_mode === undefined
        ? {}
        : { repository: request.repository_mode }),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      throw badRequest(
        `The profile is invalid: ${describeConfigError(parsed.error)}`,
        "invalid_profile",
        path === "repository" ? "repository_mode" : path,
      );
    }
    return parsed.data;
  }

  return {
    async options(caller: Caller): Promise<InstallationProfileOptionsResponse> {
      await operator(caller);
      return {
        connections: Object.entries(connections)
          .map(([id, provider]) => ({
            id,
            kind: provider.kind,
            billing:
              provider.billing === "none"
                ? ("none" as const)
                : ("metered" as const),
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        runtimes: RUNTIME_KIND_VALUES.map((kind) => ({
          runtime_kind: kind,
          permission_modes: modesOf(kind),
        })).filter((runtime) => runtime.permission_modes.length > 0),
        repositories: Object.keys(catalog.repositories)
          .sort()
          .map((id) => ({ id })),
        unattended_allowed: deps.allowUnattended,
      };
    },

    async create(
      caller: Caller,
      request: CreateInstallationProfileRequest,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await operator(caller);
      const definition = definitionOf(request);
      if (
        (OPT_IN_PERMISSION_MODES as readonly string[]).includes(
          definition.permission_mode,
        ) &&
        !deps.allowUnattended
      ) {
        throw badRequest(
          `${definition.permission_mode} needs PLATFORM_ALLOW_UNATTENDED_PERMISSIONS=true on this installation`,
          "unattended_not_allowed",
          "permission_mode",
        );
      }
      const refusal = runtimes.refusal(definition.runtime_kind, definition);
      if (refusal !== null) {
        throw badRequest(refusal, "runtime_not_installed", "runtime_kind");
      }
      const repositoryIds = [...new Set(request.repository_ids)].sort();
      const unknown = repositoryIds.find(
        (id) => !Object.hasOwn(catalog.repositories, id),
      );
      if (unknown !== undefined) {
        throw badRequest(
          `Unknown repository ${unknown}`,
          "unknown_repository",
          "repository_ids",
        );
      }
      if (definition.repository === "none" && repositoryIds.length > 0) {
        throw badRequest(
          "A profile whose repository mode is none names no repository",
          "invalid_profile",
          "repository_ids",
        );
      }
      const receiptId = newId();
      const result = await store.create({
        actor,
        receiptId,
        name: request.name,
        previousId: request.previous_id ?? null,
        definition,
        permission_mode: definition.permission_mode,
        fingerprint: definitionFingerprint(request.name, definition),
        repository_ids: repositoryIds,
        connectionId: request.connection_id,
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "stale_previous":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            result.latestId === null
              ? `${request.name} has no version yet`
              : `The latest version of ${request.name} is ${result.latestId}: make the next one from it`,
            undefined,
            { reason_code: "stale_previous", latest_id: result.latestId },
          );
        case "id_taken":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `${result.id} is already a profile id: pick another name`,
            undefined,
            { reason_code: "id_taken", field: "name" },
          );
        case "unknown_previous":
          throw badRequest(
            `Unknown profile ${request.previous_id}`,
            "unknown_previous",
            "previous_id",
          );
        default:
          await reread();
          return changed(result.record, receiptId, request.connection_id);
      }
    },

    async retire(
      caller: Caller,
      profileId: string,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await operator(caller);
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

export type InstallationProfileService = ReturnType<
  typeof createInstallationProfileService
>;

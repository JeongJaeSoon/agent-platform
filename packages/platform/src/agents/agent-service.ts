import type {
  ActivateAgentRequest,
  ActivateAgentResponse,
  ActivationCredentialUnboundDetails,
  AgentDetail,
  AgentRelease,
  CountAgentsResponse,
  CreateAgentReleaseRequest,
  CreateAgentReleaseResponse,
  CreateAgentRequest,
  ListAgentsQuery,
  ListAgentsResponse,
  UpdateAgentRequest,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND } from "../musterrolle/service-errors.ts";
import type { SlackWelcome } from "../musterrolle/slack-welcome.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import type { WorkspaceKeyStore } from "../ports/api-key-store.ts";
import type { CredentialBindingStore } from "../ports/credential-binding-store.ts";
import {
  allowedRun,
  type CatalogProfile,
  catalogProfile,
  profileModels,
  profilePinned,
  refreshWorkspaceProfilesFor,
  repositoryModeOf,
  type SessionCatalog,
  type SessionCatalogView,
  workspaceProfileRefusal,
} from "../sessions/catalog.ts";
import {
  requirePermitted,
  SessionServiceError,
  viewerOf,
} from "../sessions/session-service.ts";
import {
  assertReleaseIdentity,
  cardContentSha256,
  deriveReleaseId,
  releaseModel,
  resolveReleaseContent,
} from "./release-ids.ts";

/**
 * The release a session pins, refused when the catalog no longer runs its
 * profile as it was released. Reads no credential value.
 */
export async function resolveAgentRelease(
  deps: {
    store: Pick<AgentStore, "findRelease">;
    catalog: Pick<SessionCatalogView, "profiles" | "workspace_profiles">;
  },
  workspaceId: string,
  releaseId: string,
): Promise<AgentRelease> {
  const release = await deps.store.findRelease(workspaceId, releaseId);
  if (!release) throw NOT_FOUND();
  assertReleaseIdentity(release);
  const profileId = release.runtime_profile_id;
  await refreshWorkspaceProfilesFor(deps.catalog, [profileId]);
  const profile =
    workspaceProfileRefusal(deps.catalog, workspaceId, profileId, {
      retiredAllowed: true,
    }) === null
      ? catalogProfile(deps.catalog, profileId)
      : undefined;
  if (!profile) {
    throw new SessionServiceError(
      "PROFILE_DIGEST_MISMATCH",
      `Runtime profile ${profileId} of this release is not in this host's catalog; release the version again under a profile the catalog has`,
    );
  }
  const model = releaseModel(release);
  if (
    !profilePinned(profile, release.profile_digest) ||
    (model !== undefined && !profileModels(profile).includes(model))
  ) {
    throw new SessionServiceError(
      "PROFILE_DIGEST_MISMATCH",
      `Runtime profile ${release.runtime_profile_id} changed since this release; release the version again`,
    );
  }
  return release;
}

export function createAgentService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentStore;
  catalog: SessionCatalog;
  credentials: Pick<CredentialBindingStore, "unboundRefs">;
  /** The home channel's welcome; absent where Slack is not wired. */
  welcome?: Pick<SlackWelcome, "activated">;
  /** Where an agent key's agent is read; absent, every key is refused. */
  keys?: Pick<WorkspaceKeyStore, "find">;
}) {
  const { authorization, store, catalog, credentials } = deps;

  // A release is refused here for what its sessions would be refused for,
  // so Slack, which names no repository, gets one that can start.
  function releaseRepositoryRefusal(
    profileId: string,
    profile: CatalogProfile,
    repositoryId: string | null,
  ): string | null {
    if (allowedRun(catalog, profileId, repositoryId) !== null) return null;
    const mode = repositoryModeOf(profile);
    if (mode === "required" && repositoryId === null) {
      return `Profile ${profileId} needs a repository: send repository_id`;
    }
    if (mode === "none" && repositoryId !== null) {
      return `Profile ${profileId} runs without a repository: omit repository_id`;
    }
    return `Repository ${repositoryId} is not in the catalog or does not allow profile ${profileId}`;
  }

  function personOf(caller: Caller): string {
    const userId = caller.actor?.userId;
    if (!userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold agent.manage",
      );
    }
    return userId;
  }

  async function onWorkspace(
    caller: Caller,
    action: "agent.manage" | "agent.create",
  ): Promise<string> {
    await requirePermitted(authorization, caller, action, {
      kind: "workspace",
      id: caller.ownerId,
    });
    return personOf(caller);
  }

  async function manageAgent(caller: Caller, agentId: string) {
    await requirePermitted(authorization, caller, "agent.manage", {
      kind: "agent",
      id: agentId,
    });
    return personOf(caller);
  }

  // A key that may start sessions on its agent has to find the release to
  // name; it reads that one agent and nothing its admins manage.
  async function keysOwnAgent(
    caller: Caller,
    query: ListAgentsQuery,
  ): Promise<ListAgentsResponse> {
    // Read by the principal the policy re-reads below, so the agent asked
    // about is the one bound to the key that decision judges.
    const principal = caller.subject.principal;
    const key =
      principal?.kind === "api_key" && principal.workspace_id !== null
        ? await deps.keys?.find(principal.workspace_id, principal.id)
        : null;
    const agentId = key?.kind === "agent" ? key.agentId : null;
    if (!agentId || query.include === "summary") {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only an agent key lists agents, and only its own agent without include=summary",
      );
    }
    await requirePermitted(authorization, caller, "session.submit", {
      kind: "session",
      id: null,
      agent_id: agentId,
    });
    const detail = await store.get(caller.ownerId, agentId);
    return { items: detail ? [detail.agent] : [], next_cursor: null };
  }

  const resolveRelease = (workspaceId: string, releaseId: string) =>
    resolveAgentRelease({ store, catalog }, workspaceId, releaseId);

  return {
    resolveRelease,

    async listAgents(
      caller: Caller,
      query: ListAgentsQuery,
    ): Promise<ListAgentsResponse> {
      if (caller.actor?.principal.kind === "api_key") {
        return keysOwnAgent(caller, query);
      }
      await onWorkspace(caller, "agent.manage");
      const page = await store.list(caller.ownerId, query);
      if (query.include !== "summary") return page;
      // Listing needs agent.manage on the workspace, which already reads
      // every agent's detail, admins and bindings, so no per-agent check.
      // Sessions are counted only where the caller could list them.
      const summaries = await store.summaries(
        caller.ownerId,
        page.items.map((agent) => agent.id),
        viewerOf(caller),
      );
      return {
        ...page,
        items: page.items.map((agent) => {
          const summary = summaries.get(agent.id);
          return summary ? { ...agent, summary } : agent;
        }),
      };
    },

    async countAgents(caller: Caller): Promise<CountAgentsResponse> {
      const userId = await onWorkspace(caller, "agent.manage");
      return { counts: await store.count(caller.ownerId, userId) };
    },

    async getAgent(caller: Caller, agentId: string): Promise<AgentDetail> {
      await manageAgent(caller, agentId);
      const detail = await store.get(caller.ownerId, agentId);
      if (!detail) throw NOT_FOUND();
      return detail;
    },

    async createAgent(
      caller: Caller,
      request: CreateAgentRequest,
    ): Promise<AgentDetail> {
      // Any member may; the store makes them the agent's admin (D3).
      const userId = await onWorkspace(caller, "agent.create");
      const result = await store.create({
        principal: caller,
        workspaceId: caller.ownerId,
        slug: request.slug,
        name: request.name,
        card: request.card,
        contentSha256: cardContentSha256(request.card),
        createdBy: userId,
      });
      switch (result.outcome) {
        case "slug_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            `An agent with slug ${request.slug} already exists`,
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          return result.detail;
      }
    },

    async updateAgent(
      caller: Caller,
      agentId: string,
      request: UpdateAgentRequest,
    ): Promise<AgentDetail> {
      const userId = await manageAgent(caller, agentId);
      const result = await store.update({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.card === undefined
          ? {}
          : {
              card: {
                card: request.card,
                contentSha256: cardContentSha256(request.card),
              },
            }),
        updatedBy: userId,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          return result.detail;
      }
    },

    async createRelease(
      caller: Caller,
      agentId: string,
      request: CreateAgentReleaseRequest,
    ): Promise<CreateAgentReleaseResponse> {
      const userId = await manageAgent(caller, agentId);
      const version = await store.findVersion(
        caller.ownerId,
        agentId,
        request.version_id,
      );
      if (!version) throw NOT_FOUND();
      const profileId = request.runtime_profile_id;
      await refreshWorkspaceProfilesFor(catalog, [profileId], { strict: true });
      const workspaceRefusal = workspaceProfileRefusal(
        catalog,
        caller.ownerId,
        profileId,
      );
      if (workspaceRefusal !== null) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          workspaceRefusal.message,
          undefined,
          { reason_code: workspaceRefusal.state },
        );
      }
      const profile = catalogProfile(catalog, profileId);
      if (!profile) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `Unknown runtime_profile_id ${profileId}`,
        );
      }
      const repositoryId = request.repository_id ?? null;
      const refused = releaseRepositoryRefusal(
        profileId,
        profile,
        repositoryId,
      );
      if (refused !== null) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `repository_id: ${refused}`,
        );
      }
      const resolved = resolveReleaseContent(
        version.card,
        profileId,
        profile,
        catalog.mcp_servers,
      );
      if (!resolved.ok) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `${resolved.error.field}: ${resolved.error.message}`,
        );
      }
      const identity = {
        // As stored: PostgreSQL returns a uuid in lower case.
        agent_id: version.agent_id,
        card_sha256: version.content_sha256,
        repository_id: repositoryId,
        ...resolved.content,
      };
      const result = await store.insertRelease({
        principal: caller,
        workspaceId: caller.ownerId,
        release: {
          id: deriveReleaseId(identity),
          version_id: version.id,
          created_by: userId,
          note: request.note ?? null,
          ...identity,
        },
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          assertReleaseIdentity(result.release);
          return {
            release: result.release,
            created: result.outcome === "created",
          };
      }
    },

    async activateAgent(
      caller: Caller,
      agentId: string,
      request: ActivateAgentRequest,
    ): Promise<ActivateAgentResponse> {
      const userId = await manageAgent(caller, agentId);
      const release = await resolveRelease(caller.ownerId, request.release_id);
      if (release.agent_id !== agentId.toLowerCase()) throw NOT_FOUND();
      // Checked again when each session starts, so a binding revoked after
      // this point stops the next session rather than this activation.
      const missing = await credentials.unboundRefs(caller.ownerId, release.id);
      if (missing.length > 0) {
        const details: ActivationCredentialUnboundDetails = {
          reason_code: "credential_unbound",
          missing,
        };
        throw new SessionServiceError(
          "CREDENTIAL_UNBOUND",
          `Release ${release.id} uses credentials not bound to this agent: ${missing.join(", ")}`,
          undefined,
          details,
        );
      }
      const result = await store.activate({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        releaseId: release.id,
        expectedRevision: request.expected_revision,
        approvedBy: userId,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `Activation revision is ${result.revision}, not ${request.expected_revision}`,
          );
        case "unchanged":
          return {
            active_release_id: release.id,
            previous_release_id: null,
            activation_revision: result.revision,
            receipt_id: null,
          };
        default:
          await deps.welcome?.activated(caller.ownerId, agentId, release.id);
          return {
            active_release_id: release.id,
            previous_release_id: result.previousReleaseId,
            activation_revision: result.revision,
            receipt_id: result.receiptId,
          };
      }
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;

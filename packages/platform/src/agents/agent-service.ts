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
import type { AgentStore } from "../ports/agent-store.ts";
import type { CredentialBindingStore } from "../ports/credential-binding-store.ts";
import {
  profileModels,
  profilePinned,
  type SessionCatalog,
} from "../sessions/catalog.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  assertReleaseIdentity,
  cardContentSha256,
  deriveReleaseId,
  releaseModel,
  resolveReleaseContent,
} from "./release-ids.ts";

const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "Resource not found");
const ACTOR_INACTIVE = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "This principal is no longer a member of the workspace",
  );

export function createAgentService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentStore;
  catalog: SessionCatalog;
  credentials: Pick<CredentialBindingStore, "unboundRefs">;
}) {
  const { authorization, store, catalog, credentials } = deps;

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

  async function resolveRelease(
    workspaceId: string,
    releaseId: string,
  ): Promise<AgentRelease> {
    const release = await store.findRelease(workspaceId, releaseId);
    if (!release) throw NOT_FOUND();
    assertReleaseIdentity(release);
    const profile = Object.hasOwn(catalog.profiles, release.runtime_profile_id)
      ? catalog.profiles[release.runtime_profile_id]
      : undefined;
    const model = releaseModel(release);
    if (
      !profile ||
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

  return {
    resolveRelease,

    async listAgents(
      caller: Caller,
      query: ListAgentsQuery,
    ): Promise<ListAgentsResponse> {
      await onWorkspace(caller, "agent.manage");
      return store.list(caller.ownerId, query);
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
      const profile = Object.hasOwn(catalog.profiles, profileId)
        ? catalog.profiles[profileId]
        : undefined;
      if (!profile) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `Unknown runtime_profile_id ${profileId}`,
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
        ...resolved.content,
      };
      const result = await store.insertRelease({
        principal: caller,
        workspaceId: caller.ownerId,
        release: {
          id: deriveReleaseId(identity),
          version_id: version.id,
          created_by: userId,
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

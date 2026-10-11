import type {
  ActivateAgentRequest,
  ActivateAgentResponse,
  AgentDetail,
  AgentRelease,
  CreateAgentReleaseRequest,
  CreateAgentReleaseResponse,
  CreateAgentRequest,
  ListAgentsResponse,
  UpdateAgentRequest,
} from "@agent-platform/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import {
  profileFingerprint,
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
  resolveReleaseContent,
} from "./release-ids.ts";

export const AGENT_LIST_LIMIT = 500;

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
}) {
  const { authorization, store, catalog } = deps;

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

  async function manageWorkspace(caller: Caller): Promise<string> {
    await requirePermitted(authorization, caller, "agent.manage", {
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
    if (!profile || profileFingerprint(profile) !== release.profile_digest) {
      throw new SessionServiceError(
        "PROFILE_DIGEST_MISMATCH",
        `Runtime profile ${release.runtime_profile_id} changed since this release; release the version again`,
      );
    }
    return release;
  }

  return {
    resolveRelease,

    async listAgents(caller: Caller): Promise<ListAgentsResponse> {
      await manageWorkspace(caller);
      return { items: await store.list(caller.ownerId, AGENT_LIST_LIMIT) };
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
      const userId = await manageWorkspace(caller);
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
      const resolved = resolveReleaseContent(version.card, profileId, profile);
      if (!resolved.ok) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `${resolved.error.field}: ${resolved.error.message}`,
        );
      }
      const identity = {
        agent_id: agentId,
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
      if (release.agent_id !== agentId) throw NOT_FOUND();
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

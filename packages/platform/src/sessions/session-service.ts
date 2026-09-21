import { createHash } from "node:crypto";
import type {
  ApiErrorCode,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  SessionDetail,
  SessionRuntime,
} from "@agent-platform/contracts";
import type {
  AuthorizationPolicy,
  Principal,
} from "../authorization/policy.ts";
import type {
  InputAcceptance,
  SessionReader,
} from "../ports/session-unit-of-work.ts";
import type { SessionCatalog } from "./catalog.ts";

export class SessionServiceError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)), "utf8")
    .digest("hex");
}

export function createSessionService(deps: {
  authorization: AuthorizationPolicy;
  inputs: InputAcceptance;
  reader: SessionReader;
  catalog: SessionCatalog;
}) {
  const { authorization, inputs, reader, catalog } = deps;

  function runtimeFor(profileId: string | null): SessionRuntime {
    const profile = profileId ? catalog.profiles[profileId] : undefined;
    return {
      kind: profile?.runtime_kind ?? "claude_agent_sdk",
      version: profile?.runtime_version ?? "unknown",
      profile_id: profileId ?? "unknown",
    };
  }

  function requireAuthorized(
    actor: Principal,
    action: "sessions:read" | "sessions:write",
    ownerId: string,
  ) {
    if (!authorization.authorize(actor, action, { ownerId })) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
  }

  return {
    async createSession(
      actor: Principal,
      input: { idempotencyKey: string; body: CreateSessionRequest },
    ): Promise<CreateSessionResponse> {
      requireAuthorized(actor, "sessions:write", actor.ownerId);
      const profile = catalog.profiles[input.body.profile_id];
      const repository = catalog.repositories[input.body.repository_id];
      if (!profile || !repository) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          "Unknown profile_id or repository_id",
        );
      }
      const result = await inputs.acceptInputAtomic({
        principal: actor,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        profileId: input.body.profile_id,
        repository: { id: input.body.repository_id, ...repository },
        message: input.body.message,
      });
      if (result.outcome === "conflict") {
        throw new SessionServiceError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different payload",
        );
      }
      return result.response;
    },

    async listSessions(
      actor: Principal,
      query: ListSessionsQuery,
    ): Promise<ListSessionsResponse> {
      requireAuthorized(actor, "sessions:read", actor.ownerId);
      const page = await reader.listSessions(actor.ownerId, query);
      return {
        items: page.items.map(({ profile_id, ...item }) => ({
          ...item,
          runtime: runtimeFor(profile_id),
        })),
        next_cursor: page.next_cursor,
      };
    },

    async getSession(
      actor: Principal,
      sessionId: string,
    ): Promise<SessionDetail> {
      requireAuthorized(actor, "sessions:read", actor.ownerId);
      const record = await reader.getSession(actor.ownerId, sessionId);
      if (!record) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      const { profile_id, ...detail } = record;
      return { ...detail, runtime: runtimeFor(profile_id) };
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

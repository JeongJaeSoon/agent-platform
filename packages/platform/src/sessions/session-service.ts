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

// Plain-object catalogs must not resolve inherited keys such as "toString".
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
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
    const profile = profileId ? own(catalog.profiles, profileId) : undefined;
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
      const profile = own(catalog.profiles, input.body.profile_id);
      const repository = own(catalog.repositories, input.body.repository_id);
      const result = await inputs.acceptInputAtomic({
        principal: actor,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        profileId: input.body.profile_id,
        repository:
          profile && repository
            ? { id: input.body.repository_id, ...repository }
            : null,
        message: input.body.message,
      });
      switch (result.outcome) {
        case "conflict":
          throw new SessionServiceError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different payload",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "Unknown profile_id or repository_id",
          );
        default:
          return result.response;
      }
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

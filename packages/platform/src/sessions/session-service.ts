import { createHash } from "node:crypto";
import type {
  AdmissionState,
  ApiErrorCode,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  ListTurnsQuery,
  ListTurnsResponse,
  PostSessionMessageRequest,
  PostSessionMessageResponse,
  Receipt,
  SessionDetail,
  SessionRuntime,
  TurnDetail,
} from "@agent-platform/contracts";
import type {
  AuthorizationPolicy,
  Principal,
} from "../authorization/policy.ts";
import { checkpointAdmission } from "../checkpoints/durability.ts";
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

// api.md: pausing/paused, resuming and closed each have their own code;
// stopped requires an explicit resume; recovery_required blocks all input.
const ADMISSION_REJECTIONS: Record<
  Exclude<AdmissionState, "active">,
  { code: ApiErrorCode; message: string }
> = {
  pausing: { code: "SESSION_PAUSED", message: "Session is pausing" },
  paused: { code: "SESSION_PAUSED", message: "Session is paused" },
  resuming: { code: "SESSION_RESUMING", message: "Session is resuming" },
  stopping: {
    code: "SESSION_STOPPED",
    message: "Session is stopping; resume it before sending messages",
  },
  stopped: {
    code: "SESSION_STOPPED",
    message: "Session is stopped; resume it before sending messages",
  },
  recovery_required: {
    code: "RECOVERY_REQUIRED",
    message: "Session requires an operator recovery decision",
  },
  closed: { code: "SESSION_CLOSED", message: "Session is closed" },
};

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

    async appendMessage(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: PostSessionMessageRequest },
    ): Promise<PostSessionMessageResponse> {
      requireAuthorized(actor, "sessions:write", actor.ownerId);
      const result = await inputs.appendInputAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        message: input.body.message,
      });
      switch (result.outcome) {
        case "conflict":
          throw new SessionServiceError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different payload",
          );
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "rejected": {
          const rejection = ADMISSION_REJECTIONS[result.admissionState];
          throw new SessionServiceError(rejection.code, rejection.message);
        }
        case "checkpoint_unavailable": {
          const admission = checkpointAdmission(result.reason);
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            admission.admitted
              ? `Session cannot be checkpointed: ${result.reason}`
              : admission.message,
          );
        }
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

    async listTurns(
      actor: Principal,
      sessionId: string,
      query: ListTurnsQuery,
    ): Promise<ListTurnsResponse> {
      requireAuthorized(actor, "sessions:read", actor.ownerId);
      const page = await reader.listTurns(actor.ownerId, sessionId, query);
      if (!page) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return page;
    },

    async getTurn(
      actor: Principal,
      sessionId: string,
      turnId: string,
    ): Promise<TurnDetail> {
      requireAuthorized(actor, "sessions:read", actor.ownerId);
      const turn = await reader.getTurn(actor.ownerId, sessionId, turnId);
      if (!turn) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return turn;
    },

    // Only the principal that issued the command may read its receipt;
    // anyone else sees the same 404 as for a receipt that never existed.
    async getReceipt(actor: Principal, receiptId: string): Promise<Receipt> {
      requireAuthorized(actor, "sessions:read", actor.ownerId);
      const receipt = await reader.getReceipt(actor.ownerId, receiptId);
      if (!receipt) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return receipt;
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

import { createHash } from "node:crypto";
import type {
  AdmissionState,
  ApiErrorCode,
  ControlAcceptedResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  ListTurnsQuery,
  ListTurnsResponse,
  PauseSessionRequest,
  PostSessionMessageRequest,
  PostSessionMessageResponse,
  Receipt,
  RecoveryDecisionRequest,
  ResumeSessionRequest,
  SessionDetail,
  SessionRuntime,
  TerminateSessionRequest,
  TerminateSessionResponse,
  TurnDetail,
} from "@agent-platform/contracts";
import type {
  AuthorizationPolicy,
  Principal,
  SessionAction,
} from "../authorization/policy.ts";
import { checkpointAdmission } from "../checkpoints/durability.ts";
import { budgetExceeded } from "../limits/installation-limits.ts";
import type { SessionControl } from "../ports/session-control.ts";
import type {
  EventPage,
  InputAcceptance,
  InputLimitRefusal,
  InputLimits,
  ReadEventsQuery,
  SessionReader,
} from "../ports/session-unit-of-work.ts";
import { allowedPair, type SessionCatalog } from "./catalog.ts";

export class SessionServiceError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retry?: { afterSeconds: number },
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

// Resume from anything but `stopped`. The pause family belongs to 94S-138
// and is refused as unsupported rather than half-resumed; an active
// session has nothing to resume.
const RESUME_REJECTIONS: Record<
  Exclude<AdmissionState, "stopped" | "stopping" | "recovery_required">,
  [ApiErrorCode, string]
> = {
  active: ["REQUEST_STALE", "Session is already active"],
  pausing: [
    "UNSUPPORTED_CAPABILITY",
    "Resume from a pausing session is not available yet (94S-138)",
  ],
  paused: [
    "UNSUPPORTED_CAPABILITY",
    "Resume from a paused session is not available yet (94S-138)",
  ],
  resuming: ["SESSION_RESUMING", "Session is already resuming"],
  closed: ["SESSION_CLOSED", "Session is closed"],
};

const PAUSE_REJECTIONS: Record<
  Exclude<AdmissionState, "active">,
  [ApiErrorCode, string]
> = {
  pausing: ["SESSION_PAUSED", "Session is already pausing"],
  paused: ["SESSION_PAUSED", "Session is already paused"],
  resuming: ["SESSION_RESUMING", "Session is resuming"],
  stopping: ["SESSION_STOPPED", "Session is stopping"],
  stopped: ["SESSION_STOPPED", "Session is stopped"],
  recovery_required: [
    "RECOVERY_REQUIRED",
    "Session requires an operator recovery decision",
  ],
  closed: ["SESSION_CLOSED", "Session is closed"],
};

// Not a prediction of when the queue drains — turns wait on approvals and run
// for minutes — only a floor that keeps clients from retrying in a tight loop.
export const QUEUE_FULL_RETRY_AFTER_SECONDS = 5;

function limitError(refusal: InputLimitRefusal): SessionServiceError {
  return refusal.outcome === "queue_full"
    ? new SessionServiceError(
        "RATE_LIMITED",
        "The session already holds its limit of queued messages",
        { afterSeconds: QUEUE_FULL_RETRY_AFTER_SECONDS },
      )
    : new SessionServiceError(
        "STORAGE_LIMIT_EXCEEDED",
        "The installation has no storage left for this message",
      );
}

export function payloadHash(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(payload)), "utf8")
    .digest("hex");
}

export function createSessionService(deps: {
  authorization: AuthorizationPolicy;
  inputs: InputAcceptance;
  controls: SessionControl;
  reader: SessionReader;
  catalog: SessionCatalog;
  limits: InputLimits & { sessionCostLimitUsd: number };
  now?: () => Date;
}) {
  const { authorization, inputs, controls, reader, catalog } = deps;
  const inputLimits: InputLimits = {
    queuedInputLimitPerSession: deps.limits.queuedInputLimitPerSession,
    storageLimitBytes: deps.limits.storageLimitBytes,
  };
  const now = deps.now ?? (() => new Date());

  function runtimeFor(profileId: string | null): SessionRuntime {
    const profile = profileId ? own(catalog.profiles, profileId) : undefined;
    return {
      kind: profile?.runtime_kind ?? "claude_agent_sdk",
      version: profile?.runtime_version ?? "unknown",
      profile_id: profileId ?? "unknown",
    };
  }

  // A resource of another owner does not exist as far as this principal
  // can tell. A missing scope never reaches here: the API refuses it with
  // 403 before the body is read (94S-132). A policy that does deny a
  // recovery decision on the principal's own session answers 403 as well.
  function requireAuthorized(
    actor: Principal,
    action: SessionAction,
    ownerId: string,
  ) {
    if (actor.ownerId !== ownerId) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
    if (!authorization.authorize(actor, action, { ownerId })) {
      if (action === "sessions:recover") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "This API key does not hold sessions:recover",
        );
      }
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
  }

  function idempotencyConflict(): never {
    throw new SessionServiceError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency-Key was already used with a different payload",
    );
  }

  function revisionConflict(currentRevision: number): never {
    throw new SessionServiceError(
      "REVISION_CONFLICT",
      `expected_revision does not match the current revision ${currentRevision}`,
    );
  }

  return {
    async createSession(
      actor: Principal,
      input: { idempotencyKey: string; body: CreateSessionRequest },
    ): Promise<CreateSessionResponse> {
      requireAuthorized(actor, "sessions:write", actor.ownerId);
      // A pair the catalog does not allow is as unknown as a missing id: the
      // repository did not grant this profile its trust (94S-258).
      const pair = allowedPair(
        catalog,
        input.body.profile_id,
        input.body.repository_id,
      );
      const result = await inputs.acceptInputAtomic({
        principal: actor,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        profileId: input.body.profile_id,
        repository: pair
          ? {
              id: input.body.repository_id,
              url: pair.repository.url,
              branch: pair.repository.branch,
            }
          : null,
        message: input.body.message,
        limits: inputLimits,
      });
      switch (result.outcome) {
        case "conflict":
          throw new SessionServiceError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different payload",
          );
        case "queue_full":
        case "storage_exhausted":
          throw limitError(result);
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "Unknown profile_id or repository_id, or a pair the catalog does not allow",
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
        limits: inputLimits,
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
        case "queue_full":
        case "storage_exhausted":
          throw limitError(result);
        default:
          return result.response;
      }
    },

    async terminateSession(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: TerminateSessionRequest },
    ): Promise<TerminateSessionResponse> {
      requireAuthorized(actor, "sessions:control", actor.ownerId);
      const result = await controls.terminateAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        expectedRevision: input.body.expected_revision,
        reason: input.body.reason ?? null,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected": {
          const rejection = ADMISSION_REJECTIONS[result.admissionState];
          throw new SessionServiceError(rejection.code, rejection.message);
        }
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be force-terminated",
          );
        default:
          return { ...result.response, external_effects_reverted: false };
      }
    },

    async pauseSession(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: PauseSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      requireAuthorized(actor, "sessions:control", actor.ownerId);
      const result = await controls.pauseAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        expectedRevision: input.body.expected_revision,
        reason: input.body.reason ?? null,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected":
          throw new SessionServiceError(
            ...PAUSE_REJECTIONS[result.admissionState],
          );
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No trusted committed checkpoint covers the last turn that ran, so a pause would have nothing to restore from; terminate instead",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be paused",
          );
        default:
          return result.response;
      }
    },

    async decideRecovery(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: RecoveryDecisionRequest },
    ): Promise<ControlAcceptedResponse> {
      requireAuthorized(actor, "sessions:recover", actor.ownerId);
      const result = await controls.decideRecoveryAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        decision: input.body,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected": {
          const rejection = ADMISSION_REJECTIONS[result.admissionState];
          throw new SessionServiceError(rejection.code, rejection.message);
        }
        case "execution_unconfirmed":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            "The previous execution has not been confirmed gone; decide once its termination is observed",
          );
        case "turn_not_unknown":
          if (result.turnStatus === null) {
            throw new SessionServiceError("NOT_FOUND", "Resource not found");
          }
          throw new SessionServiceError(
            "REQUEST_STALE",
            `target_turn_id names a turn whose outcome is ${result.turnStatus}, not unknown`,
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that has no recovery path",
          );
        case "not_in_recovery":
          throw new SessionServiceError(
            "REQUEST_STALE",
            `Session is ${result.admissionState} with nothing to recover; a recovery close applies only to recovery_required, stopping, or a stopped session that cannot be resumed`,
          );
        case "checkpoint_not_covering":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No committed checkpoint reaches the target turn, so a resume would lose the confirmed work; abandon or close instead",
          );
        default:
          return result.response;
      }
    },

    async resumeSession(
      actor: Principal,
      sessionId: string,
      input: { idempotencyKey: string; body: ResumeSessionRequest },
    ): Promise<ControlAcceptedResponse> {
      requireAuthorized(actor, "sessions:control", actor.ownerId);
      const result = await controls.resumeAtomic({
        principal: actor,
        sessionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash: payloadHash(input.body),
        expectedRevision: input.body.expected_revision,
        now: now(),
      });
      switch (result.outcome) {
        case "conflict":
          return idempotencyConflict();
        case "not_found":
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        case "revision_conflict":
          return revisionConflict(result.currentRevision);
        case "rejected":
          throw new SessionServiceError(
            ...RESUME_REJECTIONS[result.admissionState],
          );
        case "recovery_required":
          throw new SessionServiceError(
            "RECOVERY_REQUIRED",
            result.unconfirmedTurnId === null
              ? "The previous execution has not been confirmed gone; an operator recovery decision is required"
              : `Turn ${result.unconfirmedTurnId} has an unknown outcome; an operator recovery decision is required`,
          );
        case "checkpoint_unavailable":
          throw new SessionServiceError(
            "CHECKPOINT_UNAVAILABLE",
            "No committed checkpoint the session can be restored from; close it through a recovery decision or create a new session",
          );
        case "unsupported":
          throw new SessionServiceError(
            "UNSUPPORTED_CAPABILITY",
            "This session runs on a legacy pod binding that cannot be resumed",
          );
        case "workspace_reclaiming":
          throw new SessionServiceError(
            "BACKEND_UNAVAILABLE",
            "The stopped session's workspace is being reclaimed; retry the same request shortly",
            // A claim settles within the pass that took it unless the daemon
            // did not answer; then the next pass settles it.
            { afterSeconds: 10 },
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
      const { profile_id, cost_usd, ...detail } = record;
      return {
        ...detail,
        // Dispatch stops at the same predicate (nextInputAtomic), so what
        // this says and what the gateway does come from one comparison.
        attention:
          detail.attention ??
          (budgetExceeded(cost_usd, deps.limits.sessionCostLimitUsd)
            ? {
                code: "BUDGET_EXCEEDED",
                reason: `The session has spent its ${deps.limits.sessionCostLimitUsd} USD budget; queued messages will not run`,
              }
            : null),
        runtime: runtimeFor(profile_id),
      };
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

    async readEvents(
      actor: Principal,
      sessionId: string,
      query: ReadEventsQuery,
    ): Promise<EventPage> {
      requireAuthorized(actor, "sessions:read", actor.ownerId);
      const page = await reader.readEvents(actor.ownerId, sessionId, query);
      if (!page) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return page;
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

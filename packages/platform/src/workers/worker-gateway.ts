import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ApiErrorCode,
  AppendEventsRequest,
  AppendEventsResponse,
  AttemptState,
  BootstrapClaimRequest,
  BootstrapClaimResponse,
  ExecutionBackend,
  FinalizeRequest,
  FinalizeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  NextInputRequest,
  NextInputResponse,
  ReleaseRequest,
  ReleaseResponse,
  SessionRuntime,
  WorkerScope,
} from "@agent-platform/contracts";
import { executionBackendSchema } from "@agent-platform/contracts";
import type { CheckpointVerifier } from "../ports/checkpoint-verifier.ts";
import type {
  ConfirmExecutionGoneResult,
  FenceRejection,
  FinalizeResult,
  ResolvedCredential,
  WorkerFence,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";

export type WorkerGatewayStatus = 400 | 401 | 403 | 404 | 409;

// A heartbeat says the attempt is alive. "allocated" would walk the attempt
// back to the state a claim leaves behind, which reopens the one-shot
// bootstrap replay; the terminal states belong to release and to the
// backend's own observation, not to a self-report.
const HEARTBEAT_STATES = new Set<AttemptState>([
  "starting",
  "running",
  "draining",
]);

export class WorkerGatewayError extends Error {
  constructor(
    readonly status: WorkerGatewayStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

// The caller as the route layer established it from the bearer token.
export type WorkerPrincipal = Exclude<ResolvedCredential, null>;

export type WorkerGatewayOptions = {
  /** How long a heartbeat extends the lease. */
  leaseTtlMs: number;
  /** Lifetime of the session token handed out by bootstrapClaim. */
  sessionTokenTtlMs?: number;
  /** Lifetime of a launch nonce registered through registerLaunch. */
  nonceTtlMs?: number;
  /** Upper bound on nextInput long-polling. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_WAIT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function hashWorkerToken(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export function generateLaunchNonce(): string {
  return `wln_${randomBytes(32).toString("base64url")}`;
}

function generateSessionToken(): string {
  return `wsc_${randomBytes(32).toString("base64url")}`;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function fenceOf(scope: WorkerScope): WorkerFence {
  return {
    sessionId: scope.session_id,
    attemptId: scope.attempt_id,
    leaseEpoch: scope.lease_epoch,
    executionGeneration: scope.execution_generation,
    authRevision: scope.auth_revision,
  };
}

function rejected(rejection: FenceRejection): never {
  if (rejection.outcome === "lease_expired") {
    throw new WorkerGatewayError(
      409,
      "LEASE_EXPIRED",
      "Lease expired; the attempt must stop writing",
    );
  }
  throw new WorkerGatewayError(
    409,
    "STALE_EPOCH",
    "Another epoch owns this session",
  );
}

// Both the replay lookup and the commit answer in the same shape.
function finalizeAnswer(result: FinalizeResult): FinalizeResponse {
  switch (result.outcome) {
    case "turn_not_found":
      throw new WorkerGatewayError(
        404,
        "NOT_FOUND",
        "Turn is not delivered to this attempt",
      );
    case "finalize_conflict":
      throw new WorkerGatewayError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "Turn already finalized under a different finalize_key or body",
      );
    case "checkpoint_rejected":
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        `Checkpoint rejected: ${result.reason}`,
      );
    case "finalized":
    case "replayed":
      return {
        turn_id: result.result.turnId,
        status: result.result.status,
        checkpoint_revision: result.result.checkpointRevision,
      };
    default:
      return rejected(result);
  }
}

export function createWorkerGateway(deps: {
  work: WorkerUnitOfWork;
  catalog: SessionCatalog;
  checkpoints: CheckpointVerifier;
  options: WorkerGatewayOptions;
}) {
  const { work, catalog, checkpoints } = deps;
  const now = deps.options.now ?? (() => new Date());
  const sleep =
    deps.options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const leaseTtlMs = deps.options.leaseTtlMs;
  const sessionTokenTtlMs =
    deps.options.sessionTokenTtlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS;
  const nonceTtlMs = deps.options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  const maxWaitMs = deps.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs =
    deps.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Only sessions this host can actually run are claimable. Letting a
  // session whose profile left the catalog start anyway would hand it a
  // guessed runtime, and the worker would run the wrong agent or crash-loop
  // through a queue slot. It waits for a host that knows the profile.
  const runnableProfiles = Object.keys(catalog.profiles);

  function runtimeFor(profileId: string | null): SessionRuntime {
    const profile = profileId ? own(catalog.profiles, profileId) : undefined;
    if (!profile || !profileId) {
      throw new WorkerGatewayError(
        409,
        "BACKEND_UNAVAILABLE",
        "The session's runtime profile is not in this host's catalog",
        true,
      );
    }
    return {
      kind: profile.runtime_kind,
      version: profile.runtime_version,
      profile_id: profileId,
    };
  }

  // The write fence comes from the token, not from the body. Checking the
  // body against it closes the race where a holder of a token that is about
  // to be revoked sends the next revision's numbers ahead of time and has
  // them accepted once the rotation lands.
  function requireScope(principal: WorkerPrincipal, scope: WorkerScope) {
    if (principal.kind !== "session") {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "Bootstrap credentials may only call bootstrapClaim",
      );
    }
    const fence = fenceOf(scope);
    if (
      principal.sessionId !== fence.sessionId ||
      principal.attemptId !== fence.attemptId
    ) {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "Token does not match the requested binding",
      );
    }
    const behind =
      fence.leaseEpoch < principal.leaseEpoch ||
      fence.executionGeneration < principal.executionGeneration ||
      fence.authRevision < principal.authRevision;
    const ahead =
      fence.leaseEpoch > principal.leaseEpoch ||
      fence.executionGeneration > principal.executionGeneration ||
      fence.authRevision > principal.authRevision;
    if (behind) {
      throw new WorkerGatewayError(
        409,
        "STALE_EPOCH",
        "The request carries an epoch older than the token's binding",
      );
    }
    if (ahead) {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "The request claims an epoch the token was not issued for",
      );
    }
    // The token's own view can still be stale against the row; the fenced
    // SQL below is what decides that.
    return fence;
  }

  return {
    // Server side: the backend records the launch it is about to start and
    // hands the returned nonce to the worker through the launch config.
    async registerLaunch(input: {
      executionId: string;
      generation: number;
      partition?: string;
      backend: ExecutionBackend;
      nonce?: string;
      // `nonce` is null when this execution was already registered: the
      // original nonce is stored only as a hash, so a caller that lost it
      // must launch a new execution rather than receive an unusable value.
    }): Promise<{ nonce: string | null; outcome: "registered" | "exists" }> {
      // The value is persisted and read back through the public session
      // contract, so a backend the contract does not name would only surface
      // as a parse failure on someone else's read.
      const backend = executionBackendSchema.safeParse(input.backend);
      if (!backend.success) {
        throw new WorkerGatewayError(
          400,
          "BAD_REQUEST",
          `Unknown execution backend: ${String(input.backend)}`,
        );
      }
      const nonce = input.nonce ?? generateLaunchNonce();
      const result = await work.registerLaunchAtomic({
        executionId: input.executionId,
        generation: input.generation,
        partition: input.partition ?? "default",
        backend: backend.data,
        nonceHash: hashWorkerToken(nonce),
        nonceExpiresAt: new Date(now().getTime() + nonceTtlMs),
      });
      return {
        nonce: result.outcome === "registered" ? nonce : null,
        outcome: result.outcome,
      };
    },

    async authenticate(token: string | null): Promise<WorkerPrincipal> {
      const principal = token
        ? await work.resolveCredential(hashWorkerToken(token), now())
        : null;
      if (!principal) {
        throw new WorkerGatewayError(
          401,
          "UNAUTHORIZED",
          "Worker token is missing, expired or revoked",
        );
      }
      return principal;
    },

    async bootstrapClaim(
      principal: WorkerPrincipal,
      request: BootstrapClaimRequest,
    ): Promise<BootstrapClaimResponse> {
      if (request.credential.kind !== "launch_nonce") {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "workload_identity bootstrap is not available on this backend",
        );
      }
      if (principal.kind !== "bootstrap") {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "bootstrapClaim requires the launch nonce as bearer token",
        );
      }
      const at = now();
      const sessionToken = generateSessionToken();
      const result = await work.claimAtomic({
        runnableProfiles,
        nonceHash: hashWorkerToken(request.credential.nonce),
        executionId: request.execution_id,
        executionGeneration: request.execution_generation,
        attemptId: `att_${randomUUID()}`,
        credentialHash: hashWorkerToken(sessionToken),
        credentialExpiresAt: new Date(at.getTime() + sessionTokenTtlMs),
        leaseExpiresAt: new Date(at.getTime() + leaseTtlMs),
        now: at,
      });
      switch (result.outcome) {
        case "invalid_credential":
          throw new WorkerGatewayError(
            401,
            "UNAUTHORIZED",
            "Launch nonce is unknown, expired or bound to another execution",
          );
        case "no_session":
          throw new WorkerGatewayError(
            404,
            "NOT_FOUND",
            "No session is waiting in this partition",
            true,
          );
        default: {
          const binding = result.binding;
          return {
            session_id: binding.sessionId,
            turn_id: null,
            attempt_id: binding.attemptId,
            lease_epoch: binding.leaseEpoch,
            execution_generation: binding.executionGeneration,
            auth_revision: binding.authRevision,
            session_credential: sessionToken,
            lease_expires_at: binding.leaseExpiresAt.toISOString(),
            runtime: runtimeFor(binding.profileId),
            restore: binding.restore,
          };
        }
      }
    },

    async nextInput(
      principal: WorkerPrincipal,
      request: NextInputRequest,
    ): Promise<NextInputResponse> {
      const fence = requireScope(principal, request);
      const deadline =
        now().getTime() + Math.min(request.wait_ms ?? 0, maxWaitMs);
      for (;;) {
        const result = await work.nextInputAtomic({ fence, now: now() });
        if (result.outcome !== "ok") rejected(result);
        if (result.input || now().getTime() >= deadline) {
          return {
            input: result.input
              ? {
                  turn_id: result.input.turnId,
                  input_id: result.input.inputId,
                  message: result.input.message,
                  delivery_started_at:
                    result.input.deliveryStartedAt.toISOString(),
                }
              : null,
            lease_expires_at: result.leaseExpiresAt.toISOString(),
          };
        }
        // Never sleep past the deadline the caller asked for: a one
        // millisecond wait must not cost a whole poll interval.
        await sleep(Math.min(pollIntervalMs, deadline - now().getTime()));
      }
    },

    async heartbeat(
      principal: WorkerPrincipal,
      request: HeartbeatRequest,
    ): Promise<HeartbeatResponse> {
      const fence = requireScope(principal, request);
      if (!HEARTBEAT_STATES.has(request.attempt_state)) {
        throw new WorkerGatewayError(
          400,
          "BAD_REQUEST",
          `attempt_state ${request.attempt_state} cannot be reported by a heartbeat`,
        );
      }
      const at = now();
      const result = await work.heartbeatAtomic({
        credentialExpiresAt: new Date(at.getTime() + sessionTokenTtlMs),
        fence,
        now: at,
        leaseExpiresAt: new Date(at.getTime() + leaseTtlMs),
        attemptState: request.attempt_state,
      });
      if (result.outcome !== "ok") rejected(result);
      return {
        lease_expires_at: result.leaseExpiresAt.toISOString(),
        auth_revision: result.authRevision,
        // Control intents arrive with 94S-127/128; nothing is pending yet.
        control_pending: false,
      };
    },

    async appendEvents(
      principal: WorkerPrincipal,
      request: AppendEventsRequest,
    ): Promise<AppendEventsResponse> {
      const fence = requireScope(principal, request);
      const result = await work.commitEventsAtomic({
        fence,
        turnId: request.turn_id,
        now: now(),
        events: request.events,
      });
      if (result.outcome === "turn_not_found") {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "Unknown turn_id, or the turn is not running on this attempt",
        );
      }
      if (result.outcome === "turn_finalized") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Turn is already finalized; its event stream is closed",
        );
      }
      if (result.outcome === "sequence_gap") {
        throw new WorkerGatewayError(
          400,
          "BAD_REQUEST",
          `Events must continue the durable prefix; resume from source_sequence ${result.acceptedThrough + 1}`,
        );
      }
      if (result.outcome === "event_conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "A source_sequence was already stored with different content",
        );
      }
      if (result.outcome !== "ok") rejected(result);
      return {
        accepted_through: result.acceptedThrough,
        cursor: result.cursor,
      };
    },

    async finalize(
      principal: WorkerPrincipal,
      request: FinalizeRequest,
    ): Promise<FinalizeResponse> {
      const fence = requireScope(principal, request);
      const attempt = {
        fence,
        now: now(),
        turnId: request.turn_id,
        finalizeKey: request.finalize_key,
        terminal: request.terminal,
        checkpoint: request.checkpoint,
      };
      // A finalize that already committed is answered from the stored turn.
      // Re-verifying its checkpoint could fail for a reason that has nothing
      // to do with this turn, and the worker has no other way to learn a
      // result that is already durable.
      const settled = await work.peekFinalizeAtomic(attempt);
      if (settled.outcome !== "open") return finalizeAnswer(settled);
      if (request.checkpoint) {
        const verdict = await checkpoints.verify({
          sessionId: request.session_id,
          checkpoint: request.checkpoint,
        });
        if (verdict.status === "rejected") {
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `Checkpoint manifest rejected: ${verdict.reason}`,
          );
        }
      }
      // Verification is a network call that can outlast the lease, so the
      // fence is judged against the clock at commit time, not the one this
      // request started with.
      return finalizeAnswer(
        await work.finalizeAtomic({ ...attempt, now: now() }),
      );
    },

    async release(
      principal: WorkerPrincipal,
      request: ReleaseRequest,
    ): Promise<ReleaseResponse> {
      const fence = requireScope(principal, request);
      const result = await work.releaseAtomic({
        fence,
        now: now(),
        reason: request.reason,
      });
      return { released: result.released };
    },

    // Server side, for the backend/reconciler that observed the exit.
    confirmExecutionGone(
      executionId: string,
    ): Promise<ConfirmExecutionGoneResult> {
      return work.confirmExecutionGoneAtomic({ executionId, now: now() });
    },
  };
}

export type WorkerGateway = ReturnType<typeof createWorkerGateway>;

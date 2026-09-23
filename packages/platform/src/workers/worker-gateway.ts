import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ApiErrorCode,
  AppendEventsRequest,
  AppendEventsResponse,
  AttemptState,
  BootstrapClaimRequest,
  BootstrapClaimResponse,
  CheckpointRequest,
  CheckpointRequestResponse,
  ExecutionBackend,
  FinalizeRequest,
  FinalizeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  NextInputRequest,
  NextInputResponse,
  PendingControlRequest,
  PendingControlResponse,
  RegisterPendingRequest,
  RegisterPendingResponse,
  ReleaseRequest,
  ReleaseResponse,
  RestorePlanRequest,
  RestorePlanResponse,
  RuntimeConfig,
  SessionRuntime,
  WorkerScope,
} from "@agent-platform/contracts";
import { executionBackendSchema } from "@agent-platform/contracts";
import type {
  CheckpointRequestDecision,
  RestorePlan,
  RestorePlanResult,
} from "../checkpoints/checkpoint-service.ts";
import { checkpointPendingReason } from "../checkpoints/durability.ts";
import type { CheckpointPointer } from "../ports/checkpoint-store.ts";
import type { CheckpointVerifier } from "../ports/checkpoint-verifier.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type {
  ConfirmExecutionGoneResult,
  FenceRejection,
  FinalizeResult,
  ResolvedCredential,
  WorkerFence,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";

export type WorkerGatewayStatus = 400 | 401 | 403 | 404 | 409 | 503;

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

/**
 * The server side of the checkpoint protocol, which `CheckpointService`
 * satisfies. Separate from the verifier so a composition without an object
 * store can still bind the gateway: it then answers every checkpoint request
 * and restore plan with CHECKPOINT_UNAVAILABLE instead of guessing.
 */
export type CheckpointProtocol = {
  requestCheckpoint(input: {
    attemptId: string;
    preparation: CheckpointRequest["preparation"];
    sessionId: string;
    pointer: CheckpointPointer | null;
  }): Promise<CheckpointRequestDecision>;
  getRestorePlan(input: {
    runtime: {
      cliVersion: string;
      engine: string;
      profileSha256: string;
      sdkVersion: string;
    };
    sessionId: string;
    pointer: CheckpointPointer | null;
  }): Promise<RestorePlanResult>;
};

export type WorkerGatewayOptions = {
  /** How long a heartbeat extends the lease. */
  leaseTtlMs: number;
  /** Lifetime of the session token handed out by bootstrapClaim. */
  sessionTokenTtlMs?: number;
  /** Lifetime of a launch nonce registered through registerLaunch. */
  nonceTtlMs?: number;
  /**
   * How long a registered permission or question takes answers (DESIGN
   * §6.4: 30 minutes). The worker is told what is left, never a deadline.
   */
  pendingTtlMs?: number;
  /** Upper bound on nextInput long-polling. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_SESSION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_NONCE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_WAIT_MS = 25_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export function hashWorkerToken(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * What a launched resource is labelled with so a later pass can tell which
 * credential it holds without reading the credential: a digest of the hash
 * the registry stores, so the registry can compute it from its own column
 * and the label is never the column's lookup key itself. Labels are readable
 * by anyone on the daemon; this reveals nothing the plaintext env var next
 * to it does not already.
 */
export function launchNonceFingerprint(nonceHash: Uint8Array): string {
  return createHash("sha256").update(nonceHash).digest("hex");
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

/**
 * The checkpoint service answers a bad checkpoint with a verdict and throws
 * only when it could not reach a verdict: S3, git or the manifest read
 * failed underneath it. Left alone, that throw becomes a non-retryable 500
 * and the worker abandons a checkpoint that may be perfectly healthy.
 */
async function checkpointInfrastructure<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof WorkerGatewayError) throw error;
    throw new WorkerGatewayError(
      503,
      "BACKEND_UNAVAILABLE",
      `Checkpoint storage could not be read: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
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
    case "checkpoint_conflict":
      throw new WorkerGatewayError(
        409,
        "REVISION_CONFLICT",
        `The checkpoint pointer stands at ${result.currentRevision ?? "none"}; request the next revision and upload again`,
      );
    case "checkpoint_required":
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        `Session cannot be checkpointed: ${result.reason}; a completed turn is recorded only with a verified checkpoint`,
      );
    case "events_incomplete":
      throw new WorkerGatewayError(
        409,
        "REVISION_CONFLICT",
        `Events are durable through source_sequence ${result.acceptedThrough}, not final_source_sequence; append the tail from ${result.acceptedThrough + 1} before finalizing`,
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

function planOnWire(plan: RestorePlan): RestorePlanResponse {
  return {
    status: "ready",
    plan: {
      revision: plan.revision,
      manifest_ref: plan.manifestRef,
      engine: plan.engine,
      resume: plan.resume,
      cwd: plan.cwd,
      git_commit: plan.gitCommit,
      artifacts: plan.artifacts.map((artifact) =>
        artifact.kind === "workspace_untracked"
          ? {
              kind: artifact.kind,
              label: artifact.label,
              objects: artifact.objects.map((object) => ({
                key: object.key,
                bytes: object.bytes,
                sha256: object.sha256,
                path: object.path,
              })),
            }
          : {
              kind: artifact.kind,
              label: artifact.label,
              objects: artifact.objects.map((object) => ({
                key: object.key,
                bytes: object.bytes,
                sha256: object.sha256,
              })),
            },
      ),
      object_keys: [...plan.objectKeys],
    },
  };
}

export function createWorkerGateway(deps: {
  work: WorkerUnitOfWork;
  catalog: SessionCatalog;
  checkpoints: CheckpointVerifier;
  // Absent when no object store is configured; see CheckpointProtocol.
  checkpointProtocol?: CheckpointProtocol;
  // Absent, the pending routes answer 404 and the worker denies what it
  // cannot put to anyone; heartbeat then never reports an answer waiting.
  pending?: WorkerPendingStore;
  options: WorkerGatewayOptions;
}) {
  const { work, catalog, checkpoints, pending } = deps;
  const protocol = deps.checkpointProtocol;
  function requireProtocol(): CheckpointProtocol {
    if (protocol === undefined) {
      throw new WorkerGatewayError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        "No checkpoint object store is configured on this control plane",
      );
    }
    return protocol;
  }
  const now = deps.options.now ?? (() => new Date());
  const sleep =
    deps.options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const leaseTtlMs = deps.options.leaseTtlMs;
  const sessionTokenTtlMs =
    deps.options.sessionTokenTtlMs ?? DEFAULT_SESSION_TOKEN_TTL_MS;
  const nonceTtlMs = deps.options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
  const pendingTtlMs = deps.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const maxWaitMs = deps.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs =
    deps.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Only sessions this host can actually run are claimable. Letting a
  // session whose profile left the catalog start anyway would hand it a
  // guessed runtime, and the worker would run the wrong agent or crash-loop
  // through a queue slot. It waits for a host that knows the profile.
  const runnableProfiles = Object.keys(catalog.profiles);

  // Resolved at claim time, on purpose: the catalog is where an operator
  // rotates a provider credential, and the next claim (a new generation, or
  // a replay) is when the worker should see it. Everything else under a
  // profile id is meant to stay put — a session's checkpoint fingerprint
  // and transcript were made with that model and those tools, so a changed
  // setting is a new profile id, not an edit. What the session was created
  // against — its repository — comes from the row (WorkerBinding.repository).
  function resolveProfile(profileId: string | null): {
    runtime: SessionRuntime;
    runtime_config: RuntimeConfig;
  } {
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
      runtime: {
        kind: profile.runtime_kind,
        version: profile.runtime_version,
        profile_id: profileId,
      },
      runtime_config: {
        model: profile.model,
        tools: profile.tools,
        permission_mode: profile.permission_mode,
        provider: profile.provider,
        project_settings: profile.project_settings,
      },
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

  function requirePending(): WorkerPendingStore {
    if (!pending) {
      throw new WorkerGatewayError(
        404,
        "NOT_FOUND",
        "This gateway does not serve pending requests",
      );
    }
    return pending;
  }

  return {
    // Server side: the backend records the launch it is about to start and
    // hands the returned nonce to the worker through the launch config.
    async registerLaunch(input: {
      executionId: string;
      generation: number;
      partition?: string;
      // Pins the claim to one session. A backend that gives the container a
      // session's workspace must set it; a pool of interchangeable workers
      // leaves it out and the server picks from the partition.
      sessionId?: string;
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
        sessionId: input.sessionId ?? null,
        backend: backend.data,
        nonceHash: hashWorkerToken(nonce),
        nonceTtlMs,
      });
      return {
        nonce: result.outcome === "registered" ? nonce : null,
        outcome: result.outcome,
      };
    },

    async authenticate(token: string | null): Promise<WorkerPrincipal> {
      const principal = token
        ? await work.resolveCredential(hashWorkerToken(token))
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
        credentialTtlMs: sessionTokenTtlMs,
        leaseTtlMs,
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
        case "profile_unavailable":
          throw new WorkerGatewayError(
            409,
            "BACKEND_UNAVAILABLE",
            "The session's runtime profile is not in this host's catalog",
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
            ...resolveProfile(binding.profileId),
            workspace: { repository: binding.repository },
            principal: { owner_scope: binding.ownerScope },
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
        // A draining attempt is never handed new input, so waiting out the
        // poll would only hold up its shutdown.
        if (
          result.input ||
          result.draining === true ||
          now().getTime() >= deadline
        ) {
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
        credentialTtlMs: sessionTokenTtlMs,
        fence,
        now: at,
        leaseTtlMs,
        attemptState: request.attempt_state,
        ...(request.transcript === undefined
          ? {}
          : {
              transcript: {
                persistedAt:
                  request.transcript.persisted_at === null
                    ? null
                    : new Date(request.transcript.persisted_at),
                mirrorError: request.transcript.mirror_error,
              },
            }),
      });
      if (result.outcome !== "ok") rejected(result);
      return {
        lease_expires_at: result.leaseExpiresAt.toISOString(),
        auth_revision: result.authRevision,
        // A hint, read after the fenced write: the worker's pendingControl
        // poll is what actually hands anything over. Control intents join
        // it with 94S-128.
        control_pending: (await pending?.hasUndelivered(fence)) ?? false,
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

    async registerPending(
      principal: WorkerPrincipal,
      request: RegisterPendingRequest,
    ): Promise<RegisterPendingResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().registerAtomic({
        fence,
        turnId: request.turn_id,
        requestId: request.request_id,
        inputHash: request.input_hash,
        request: request.request,
        ttlMs: pendingTtlMs,
      });
      if (result.outcome === "turn_not_found") {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "Unknown turn_id, or the turn is not running on this attempt",
        );
      }
      if (result.outcome === "conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "request_id is already registered for a different or settled request",
        );
      }
      if (!("expiresAt" in result)) return rejected(result);
      return {
        request_id: request.request_id,
        expires_at: result.expiresAt.toISOString(),
        expires_in_ms: result.expiresInMs,
      };
    },

    async pendingControl(
      principal: WorkerPrincipal,
      request: PendingControlRequest,
    ): Promise<PendingControlResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().pendingControlAtomic({
        fence,
        answersAfter: request.answers_after,
        settled: request.settled ?? [],
      });
      if (result.outcome !== "ok") return rejected(result);
      return {
        control: null,
        answers: result.answers.map((item) => ({
          sequence: item.sequence,
          answer: item.answer,
          input_hash: item.inputHash,
        })),
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
        finalSourceSequence: request.final_source_sequence,
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
        const checkpoint = request.checkpoint;
        const verdict = await checkpointInfrastructure(() =>
          checkpoints.verify({
            fence,
            turnId: request.turn_id,
            checkpoint,
            at: attempt.now,
          }),
        );
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

    // Where the next checkpoint goes. The fenced read comes first: a stale
    // attempt gets STALE_EPOCH here rather than a key it would upload to for
    // nothing, and the runtime's durable refusal is recorded before the
    // answer says "blocked", so a crash in between cannot lose it.
    async requestCheckpoint(
      principal: WorkerPrincipal,
      request: CheckpointRequest,
    ): Promise<CheckpointRequestResponse> {
      const fence = requireScope(principal, request);
      const service = requireProtocol();
      const durable =
        request.preparation.status === "rejected"
          ? checkpointPendingReason(request.preparation)
          : null;
      const state = await work.checkpointStateAtomic({
        fence,
        now: now(),
        ...(durable === null ? {} : { pendingReason: durable }),
      });
      if (state.outcome !== "ok") rejected(state);
      if (request.preparation.status === "rejected") {
        return {
          status: "blocked",
          reason: request.preparation.reason,
          detail: request.preparation.detail,
        };
      }
      // Built from the pointer the fenced transaction read, so the answer
      // and the fence come from one snapshot. The revision it names is the
      // only one finalize will accept next; a pointer that moves in between
      // (another finalize of this attempt) makes the upload a 409 there.
      const preparation = request.preparation;
      const decision = await checkpointInfrastructure(() =>
        service.requestCheckpoint({
          attemptId: fence.attemptId,
          preparation,
          sessionId: fence.sessionId,
          pointer: state.pointer,
        }),
      );
      if (decision.status === "blocked") {
        return {
          status: "blocked",
          reason: decision.reason,
          detail: decision.detail,
        };
      }
      return {
        status: "ready",
        revision: decision.request.revision,
        manifest_ref: decision.request.manifestRef,
      };
    },

    // The committed checkpoint as a download list, or the reason there is
    // none the worker may resume from. Fenced like every post-claim call: a
    // worker that no longer owns the session learns that, not the plan.
    async restorePlan(
      principal: WorkerPrincipal,
      request: RestorePlanRequest,
    ): Promise<RestorePlanResponse> {
      const fence = requireScope(principal, request);
      const service = requireProtocol();
      const state = await work.checkpointStateAtomic({ fence, now: now() });
      if (state.outcome !== "ok") rejected(state);
      const result = await checkpointInfrastructure(() =>
        service.getRestorePlan({
          runtime: {
            cliVersion: request.runtime.cli_version,
            engine: request.runtime.engine,
            profileSha256: request.runtime.profile_sha256,
            sdkVersion: request.runtime.sdk_version,
          },
          sessionId: fence.sessionId,
          pointer: state.pointer,
        }),
      );
      switch (result.status) {
        case "none":
          return { status: "none" };
        case "unavailable":
          return {
            status: "unavailable",
            code: result.code,
            reason: result.reason,
          };
        case "incompatible":
          return {
            status: "incompatible",
            code: result.code,
            mismatches: result.mismatches.map((mismatch) => ({ ...mismatch })),
          };
        default:
          return planOnWire(result.plan);
      }
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

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
  FinalizeRequest,
  FinalizeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  NextInputRequest,
  NextInputResponse,
  ParkDeclinedRequest,
  ParkDeclinedResponse,
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
  WorkerReadyRequest,
  WorkerReadyResponse,
  WorkerScope,
} from "@werft-ai/contracts";
import { MAX_RESTORE_PROFILES } from "@werft-ai/contracts";
import {
  type CheckpointRequestDecision,
  type RestoreFallback,
  type RestorePlan,
  type RestorePlanResult,
  sessionObjectPrefix,
} from "../checkpoints/checkpoint-service.ts";
import { own } from "../checkpoints/checkpoint-support.ts";
import { checkpointPendingReason } from "../checkpoints/durability.ts";
import { budgetExceeded } from "../limits/installation-limits.ts";
import {
  type PricedBy,
  type ProviderUsage,
  priceProviderUsage,
} from "../limits/model-prices.ts";
import type { CheckpointPointer } from "../ports/checkpoint-store.ts";
import type {
  CheckpointOutputObject,
  CheckpointVerifier,
} from "../ports/checkpoint-verifier.ts";
import {
  type ForgeResolver,
  type GitCredential,
  repoRefOf,
} from "../ports/forge.ts";
import type { McpEgressStore } from "../ports/mcp-egress.ts";
import type { WorkerPendingStore } from "../ports/pending-requests.ts";
import type { SessionTitleStore } from "../ports/session-title-store.ts";
import type {
  EgressBindings,
  EgressIssue,
  EgressPurpose,
  FenceRejection,
  FinalizeResult,
  ResolvedCredential,
  RunnablePair,
  WorkerBinding,
  WorkerFence,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import {
  allowedPair,
  catalogProfile,
  catalogRevision,
  type EgressUpstream,
  mcpBinding,
  type ProfilePin,
  profileFingerprint,
  profilePins,
  providerUpstreamOf,
  refreshWorkspaceProfilesFor,
  repositoryBinding,
  repositoryModeOf,
  repositoryUpstreamOf,
  runtimeConfigOf,
  runtimeConfigWithMcp,
  type SessionCatalog,
  type SessionMcp,
  sessionProfile,
  type WorkspaceProfiles,
  workspaceCatalogProfiles,
} from "../sessions/catalog.ts";
import {
  hashTitleToken,
  type SessionTitler,
  titleProfile,
} from "../sessions/session-titler.ts";
import { createMcpEgress, type McpEgressRequest } from "./mcp-egress.ts";

const WORKSPACE_PROFILE_MAX_AGE_MS = 1000;

export type WorkerGatewayStatus = 400 | 401 | 403 | 404 | 409 | 503;

// A heartbeat says the attempt is alive. "allocated" would walk the attempt
// back to the state a claim leaves behind, which reopens the one-shot
// bootstrap replay; the terminal states belong to release and to the
// backend's own observation, not to a self-report.
export const HEARTBEAT_STATES = new Set<AttemptState>([
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
    readonly receiptId?: string,
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
    alternateProfileSha256s?: readonly string[];
    sessionId: string;
    pointer: CheckpointPointer | null;
  }): Promise<RestorePlanResult>;
};

export type WorkerGatewayOptions = {
  /** How long a heartbeat extends the lease. */
  leaseTtlMs: number;
  /** SESSION_COST_LIMIT_USD: past it a session is dispatched nothing new. */
  sessionCostLimitUsd: number;
  /** SESSION_TOKEN_LIMIT, held the same way; null, none. */
  sessionTokenLimit: number | null;
  /** Lifetime of the session token handed out by bootstrapClaim. */
  sessionTokenTtlMs?: number;
  /**
   * How long a registered permission or question takes answers (30 minutes
   * by default). The worker is told what is left, never a deadline.
   */
  pendingTtlMs?: number;
  /** Upper bound on nextInput long-polling. */
  maxWaitMs?: number;
  /** Once aborted, nextInput answers with what it has instead of waiting. */
  stopWaiting?: AbortSignal;
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

// Prefixes say which route a token is for when one turns up in a log or an
// event; the gateway never trusts them, the stored purpose decides.
const EGRESS_TOKEN_PREFIXES: Record<EgressPurpose, string> = {
  provider: "wep",
  repository: "wer",
  object_store: "weo",
  mcp: "wem",
};

function generateEgressToken(purpose: EgressPurpose): string {
  return `${EGRESS_TOKEN_PREFIXES[purpose]}_${randomBytes(32).toString("base64url")}`;
}

/** What the egress proxy is told to do with one authorized request. */
export type EgressGrant = {
  session_id: string;
  attempt_id: string;
  upstream: EgressUpstream;
};

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
const FIRST_TURN_ID = "1";

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

function versionOnWire(object: { version?: string }): { version?: string } {
  return object.version === undefined ? {} : { version: object.version };
}

/** The service's restore plan as the worker protocol answers it. */
export function restorePlanOnWire(
  result: RestorePlanResult,
): RestorePlanResponse {
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
        ...(result.fallback === undefined
          ? {}
          : {
              fallback: {
                ...fallbackOnWire(result.fallback),
                revision: result.fallback.revision,
              },
            }),
      };
    default:
      return planOnWire(result.plan);
  }
}

function planOnWire(plan: RestorePlan): RestorePlanResponse {
  return {
    status: "ready",
    plan: {
      revision: plan.revision,
      manifest_ref: plan.manifestRef,
      manifest_sha256: plan.manifestSha256,
      ...(plan.manifestVersion === undefined
        ? {}
        : { manifest_version: plan.manifestVersion }),
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
                ...versionOnWire(object),
                path: object.path,
                ...(object.executable === true ? { executable: true } : {}),
              })),
            }
          : {
              kind: artifact.kind,
              label: artifact.label,
              objects: artifact.objects.map((object) => ({
                key: object.key,
                bytes: object.bytes,
                sha256: object.sha256,
                ...versionOnWire(object),
              })),
            },
      ),
      object_keys: [...plan.objectKeys],
      ...(plan.fallback === undefined
        ? {}
        : { fallback: fallbackOnWire(plan.fallback) }),
    },
  };
}

function fallbackOnWire(fallback: RestoreFallback) {
  return {
    pointer_revision: fallback.pointerRevision,
    skipped: fallback.skipped.map((skip) => ({
      revision: skip.revision,
      reason: skip.reason,
    })),
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
  // The forge behind each catalog repository that has one. Absent, a
  // repository whose credential a forge issues (`github_app`) is refused.
  forges?: ForgeResolver;
  // Absent, the remote MCP route is refused: nothing can say whether the
  // agent's credential is still bound.
  mcp?: McpEgressStore;
  onMcpReceiptError?: (error: unknown) => void;
  // Absent, a session keeps the title cut from its first message.
  titles?: { store: SessionTitleStore; titler: SessionTitler };
  options: WorkerGatewayOptions;
}) {
  const { work, catalog, checkpoints, pending } = deps;
  const decideMcp =
    deps.mcp === undefined
      ? null
      : createMcpEgress({
          catalog,
          store: deps.mcp,
          ...(deps.onMcpReceiptError === undefined
            ? {}
            : { onReceiptError: deps.onMcpReceiptError }),
        });
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
  const tokenLimit = deps.options.sessionTokenLimit;
  const pendingTtlMs = deps.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const maxWaitMs = deps.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs =
    deps.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Only sessions this host can actually run are claimable. Letting a
  // session whose profile left the catalog start anyway would hand it a
  // guessed runtime, and the worker would run the wrong agent or crash-loop
  // through a queue slot. It waits for a host that knows the profile — as
  // the session was created with it — and that still lets it run
  // against the session's repository, or without one.
  const operatorRunnable: RunnablePair[] = [
    ...Object.entries(catalog.repositories).flatMap(
      ([repositoryId, repository]) =>
        repository.profiles.flatMap((profileId) => {
          const profile = own(catalog.profiles, profileId);
          // A row from before the pin binds to the first pair that
          // matches it: the current fingerprint and the default model.
          return profile
            ? profilePins(profile).map((pin) => ({
                profileId,
                profileFingerprint: pin.fingerprint,
                model: pin.model,
                repositoryId,
                url: repository.url,
                branch: repository.branch,
              }))
            : [];
        }),
    ),
    ...Object.entries(catalog.profiles).flatMap(([profileId, profile]) =>
      repositoryModeOf(profile) === "required"
        ? []
        : profilePins(profile).map((pin) => ({
            profileId,
            profileFingerprint: pin.fingerprint,
            model: pin.model,
            repositoryId: null,
          })),
    ),
  ];

  let runnableOf: {
    records: WorkspaceProfiles["records"] | undefined;
    pairs: RunnablePair[];
  } | null = null;
  function runnablePairs(): RunnablePair[] {
    const records = catalog.workspace_profiles?.records;
    if (runnableOf?.records !== records || runnableOf === null) {
      runnableOf = { records, pairs: buildRunnablePairs() };
    }
    return runnableOf.pairs;
  }
  function buildRunnablePairs(): RunnablePair[] {
    return [
      ...operatorRunnable,
      ...workspaceCatalogProfiles(catalog).flatMap(
        ({ id, baseId, profile }) => [
          ...Object.entries(catalog.repositories).flatMap(
            ([repositoryId, repository]) =>
              repository.profiles.includes(baseId)
                ? profilePins(profile).map((pin) => ({
                    profileId: id,
                    profileFingerprint: pin.fingerprint,
                    model: pin.model,
                    repositoryId,
                    url: repository.url,
                    branch: repository.branch,
                  }))
                : [],
          ),
          ...(repositoryModeOf(profile) === "required"
            ? []
            : profilePins(profile).map((pin) => ({
                profileId: id,
                profileFingerprint: pin.fingerprint,
                model: pin.model,
                repositoryId: null,
              }))),
        ],
      ),
    ];
  }

  async function refreshForClaim(): Promise<void> {
    await catalog.workspace_profiles
      ?.refresh(WORKSPACE_PROFILE_MAX_AGE_MS)
      .catch(() => undefined);
  }

  const revision = catalogRevision(catalog);

  function claimedMcp(mcp: SessionMcp | null | undefined) {
    const server = mcp ? own(catalog.mcp_servers ?? {}, mcp.server) : undefined;
    if (!mcp || !server) return null;
    return {
      name: mcp.server,
      endpoint: server.url,
      binding: mcpBinding(mcp.releaseId, mcp.server, server),
      tools: mcp.tools,
    };
  }

  function withMcp(
    config: RuntimeConfig,
    mcp: ReturnType<typeof claimedMcp>,
    mcpToken: string,
  ): RuntimeConfig {
    return mcp === null ? config : runtimeConfigWithMcp(config, mcp, mcpToken);
  }

  // Resolved at claim time, on purpose: the catalog is where an operator
  // rotates a provider credential, and the next claim (a new generation, or
  // a replay) is when the egress route should use it. Everything else under
  // a profile id stays put — a session's checkpoint fingerprint and
  // transcript were made with that model and those tools — and the claim
  // enforces it: only a profile that still hashes to the session's stored
  // fingerprint is runnable, so what is read here is what the
  // session was created with. What the session was created against — its
  // repository — comes from the row (WorkerBinding.repository).
  function resolveProfile(
    profileId: string | null,
    pin: ProfilePin,
    providerToken: string,
    hasRepository: boolean,
  ): {
    runtime: SessionRuntime;
    profile_fingerprint: string;
    runtime_config: RuntimeConfig;
  } {
    const listed = profileId ? catalogProfile(catalog, profileId) : undefined;
    const profile = listed ? sessionProfile(listed, pin) : null;
    if (!profile || !profileId) {
      throw new WorkerGatewayError(
        503,
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
      profile_fingerprint: profileFingerprint(profile),
      runtime_config: runtimeConfigOf(profile, providerToken, hasRepository),
    };
  }

  // The configs the session's checkpoints were made under other than the
  // one it runs now: the worker accepts a restored checkpoint, the pointer's
  // or a fallback's, made under any of them, and runs the engine on
  // runtime_config. A profile this catalog no longer holds as it was is left
  // out, so a checkpoint made under it is refused as incompatible.
  function restoreRuntimesOf(
    binding: Pick<
      WorkerBinding,
      | "profileId"
      | "profileFingerprint"
      | "model"
      | "restoreProfiles"
      | "repository"
    >,
    providerToken: string,
    mcp: ReturnType<typeof claimedMcp>,
    mcpToken: string,
  ): { restore_runtime_configs?: RuntimeConfig[] } {
    const configs = binding.restoreProfiles.flatMap((made) => {
      if (
        made.profileId === binding.profileId &&
        made.profileFingerprint === binding.profileFingerprint &&
        (made.model === null || made.model === binding.model)
      ) {
        return [];
      }
      const listed = catalogProfile(catalog, made.profileId);
      const profile = listed
        ? sessionProfile(listed, {
            fingerprint: made.profileFingerprint,
            model: made.model,
          })
        : null;
      return profile
        ? [
            withMcp(
              runtimeConfigOf(
                profile,
                providerToken,
                binding.repository !== null,
              ),
              mcp,
              mcpToken,
            ),
          ]
        : [];
    });
    return configs.length === 0
      ? {}
      : { restore_runtime_configs: configs.slice(0, MAX_RESTORE_PROFILES) };
  }

  // What each egress token is held to, taken from the catalog at the moment
  // the claim binds the session. Only a runnable pair is ever claimed, so
  // its entries exist here.
  function egressBindingsOf(
    session: Parameters<EgressIssue["bindingsOf"]>[0],
  ): EgressBindings {
    const listed = session.profileId
      ? catalogProfile(catalog, session.profileId)
      : undefined;
    const profile = listed
      ? sessionProfile(listed, {
          fingerprint: session.profileFingerprint,
          model: session.model,
        })
      : null;
    if (!profile) {
      throw new Error("A claimed session has no runnable profile");
    }
    // A session pinned under version 1 keeps that pin in its token: an API
    // replica from before version 2, still up during a rollout, accepts only
    // that.
    const provider = session.profileFingerprint ?? profileFingerprint(profile);
    const object_store = sessionObjectPrefix(session.id);
    const mcp = claimedMcp(session.mcp);
    const mcpBinding = mcp === null ? {} : { mcp: mcp.binding };
    if (session.repositoryMode === "none") {
      return { provider, repository: null, object_store, ...mcpBinding };
    }
    const repository = session.repositoryId
      ? own(catalog.repositories, session.repositoryId)
      : undefined;
    if (!repository || session.repositoryId === null) {
      throw new Error("A claimed session has no runnable repository");
    }
    return {
      provider,
      repository: repositoryBinding(session.repositoryId, repository),
      object_store,
      ...mcpBinding,
    };
  }

  // A catalog that moved since the claim (an edited config and a restart)
  // is not followed: the attempt agreed to one endpoint and one repository.
  // The proxy is refused rather than pointed somewhere new.
  function moved(what: string): never {
    throw new WorkerGatewayError(
      409,
      "CATALOG_MISMATCH",
      `The ${what} changed in the catalog since this attempt was claimed`,
    );
  }
  function forgeUnavailable(): never {
    throw new WorkerGatewayError(
      503,
      "BACKEND_UNAVAILABLE",
      "The repository's forge credential could not be issued",
      true,
    );
  }

  // A title request's token, held to the session's budget and profile as
  // the engine's calls are; null for any other token. No fence: the attempt
  // it is charged to may have ended since its first turn.
  async function authorizedTitleEgress(
    token: string,
  ): Promise<EgressGrant | null> {
    if (deps.titles === undefined) return null;
    const result = await deps.titles.store.authorizeAtomic({
      tokenHash: hashTitleToken(token),
    });
    if (result.outcome !== "ok") return null;
    if (result.profileId !== null) {
      await refreshWorkspaceProfilesFor(catalog, [result.profileId]);
    }
    if (
      budgetExceeded(result, {
        costUsd: deps.options.sessionCostLimitUsd,
        tokens: tokenLimit,
      })
    ) {
      throw new WorkerGatewayError(
        403,
        "BUDGET_EXCEEDED",
        "The session has reached its cost or token limit",
      );
    }
    const profile = titleProfile(catalog, result);
    if (profile === null) moved("session's profile");
    return {
      session_id: result.sessionId,
      attempt_id: result.attemptId,
      upstream: providerUpstreamOf(profile),
    };
  }

  // What an egress token stands for once its attempt still owns the session;
  // anything else is refused here, before any route looks at the request.
  async function authorizedEgress(request: {
    token: string;
    purpose: EgressPurpose;
  }) {
    const result = await work.authorizeEgressAtomic({
      tokenHash: hashWorkerToken(request.token),
      purpose: request.purpose,
    });
    if (result.outcome === "invalid_token") {
      throw new WorkerGatewayError(
        401,
        "UNAUTHORIZED",
        "Egress token is missing, expired, revoked or for another route",
      );
    }
    if (result.outcome !== "ok") {
      throw new WorkerGatewayError(
        403,
        "FORBIDDEN",
        "The attempt this token belongs to no longer owns its session",
      );
    }
    return result;
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
      const providerToken = generateEgressToken("provider");
      const repositoryToken = generateEgressToken("repository");
      const objectStoreToken = generateEgressToken("object_store");
      const mcpToken = generateEgressToken("mcp");
      await refreshForClaim();
      const result = await work.claimAtomic({
        runnable: runnablePairs(),
        catalogRevision: revision,
        workspaceProfileIds: new Set(
          catalog.workspace_profiles?.records.keys() ?? [],
        ),
        costLimitUsd: deps.options.sessionCostLimitUsd,
        tokenLimit,
        nonceHash: hashWorkerToken(request.credential.nonce),
        executionId: request.execution_id,
        executionGeneration: request.execution_generation,
        attemptId: `att_${randomUUID()}`,
        credentialHash: hashWorkerToken(sessionToken),
        credentialTtlMs: sessionTokenTtlMs,
        egress: {
          providerHash: hashWorkerToken(providerToken),
          repositoryHash: hashWorkerToken(repositoryToken),
          objectStoreHash: hashWorkerToken(objectStoreToken),
          mcpHash: hashWorkerToken(mcpToken),
          bindingsOf: egressBindingsOf,
        },
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
            503,
            "BACKEND_UNAVAILABLE",
            "The session's profile, or its pairing with the session's repository, is not in this host's catalog",
            true,
          );
        // Not retryable: the session is no longer waiting for a worker, and
        // the one that asked has nothing to do but leave.
        case "context_gap":
          throw new WorkerGatewayError(
            409,
            "RECOVERY_REQUIRED",
            "The session has turns no checkpoint covers; an operator decides how it continues",
          );
        // Not retryable: the session this launch was for has been failed and
        // the launch asked to go, so a retry could only find nothing.
        case "catalog_mismatch":
          throw new WorkerGatewayError(
            409,
            "CATALOG_MISMATCH",
            "The session this launch was reserved for runs as a profile and repository pair this host's catalog no longer allows; the session was failed",
          );
        default: {
          const binding = result.binding;
          const mcp = claimedMcp(binding.mcp);
          const profile = resolveProfile(
            binding.profileId,
            { fingerprint: binding.profileFingerprint, model: binding.model },
            providerToken,
            binding.repository !== null,
          );
          const resolved = {
            ...profile,
            runtime_config: withMcp(profile.runtime_config, mcp, mcpToken),
          };
          return {
            session_id: binding.sessionId,
            turn_id: null,
            attempt_id: binding.attemptId,
            lease_epoch: binding.leaseEpoch,
            execution_generation: binding.executionGeneration,
            auth_revision: binding.authRevision,
            session_credential: sessionToken,
            lease_expires_at: binding.leaseExpiresAt.toISOString(),
            lease_remaining_ms: binding.leaseRemainingMs,
            ...resolved,
            ...restoreRuntimesOf(binding, providerToken, mcp, mcpToken),
            workspace: {
              repository: binding.repository && {
                ...binding.repository,
                access: { kind: "egress_token", token: repositoryToken },
              },
            },
            object_store: {
              access: { kind: "egress_token", token: objectStoreToken },
            },
            principal: { owner_scope: binding.ownerScope },
            restore: binding.restore,
            // A replay can bind a session that has since spent its budget;
            // its engine gets nothing to spend, and nextInput hands it no turn.
            // An unmetered session gets no budget at all: the engine would
            // price a model it does not know at a guessed rate and cut the
            // turn on it.
            remaining_budget_usd: binding.unmetered
              ? null
              : Math.max(0, deps.options.sessionCostLimitUsd - binding.costUsd),
          };
        }
      }
    },

    // The object store route's question, asked on every request
    // like the others: which session prefix does this token still reach?
    // Only the prefix comes back; which requests under it are signed is the
    // API's object store signer's to decide, since only it holds the key.
    async authorizeObjectAccess(request: {
      token: string;
    }): Promise<{ session_id: string; attempt_id: string; scope: string }> {
      const result = await authorizedEgress({
        token: request.token,
        purpose: "object_store",
      });
      // Issued from the session id, so a mismatch is a row nobody should
      // have written; it reaches nothing rather than whatever it names.
      if (result.binding !== sessionObjectPrefix(result.sessionId)) {
        throw new WorkerGatewayError(
          403,
          "FORBIDDEN",
          "The token's object prefix is not its session's",
        );
      }
      return {
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        scope: result.binding,
      };
    },

    // The egress proxy's question, asked on every request to a credential
    // route: what does this token stand for right now? The answer
    // carries the upstream credential, so only the authorizer listener —
    // unreachable from any worker — may put it on the wire.
    async authorizeMcpEgress(
      request: { token: string } & McpEgressRequest,
    ): Promise<EgressGrant> {
      const result = await authorizedEgress({
        token: request.token,
        purpose: "mcp",
      });
      if (decideMcp === null) {
        throw new WorkerGatewayError(
          503,
          "BACKEND_UNAVAILABLE",
          "This gateway does not serve the MCP route",
          true,
        );
      }
      const decision = await decideMcp(result, request);
      if (decision.kind === "refused") {
        throw new WorkerGatewayError(
          decision.status,
          decision.code,
          decision.message,
          false,
          decision.receiptId,
        );
      }
      return {
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        upstream: decision.upstream,
      };
    },

    async authorizeEgress(request: {
      token: string;
      purpose: "provider" | "repository";
    }): Promise<EgressGrant> {
      if (request.purpose === "provider") {
        const titled = await authorizedTitleEgress(request.token);
        if (titled !== null) return titled;
      }
      const result = await authorizedEgress(request);
      const grant = (upstream: EgressUpstream): EgressGrant => ({
        session_id: result.sessionId,
        attempt_id: result.attemptId,
        upstream,
      });
      // The attempt may have been claimed on a replica that read the
      // version before this one did.
      await refreshWorkspaceProfilesFor(catalog, [result.profileId]);
      if (request.purpose === "provider") {
        // What a session has spent is metered here, a tool's direct calls
        // with the engine's token included; a session past its
        // limit gets no new provider exchange, and the proxy's regrant cuts
        // an open one.
        if (
          budgetExceeded(result, {
            costUsd: deps.options.sessionCostLimitUsd,
            tokens: tokenLimit,
          })
        ) {
          throw new WorkerGatewayError(
            403,
            "BUDGET_EXCEEDED",
            "The session has reached its cost or token limit",
          );
        }
        const listed = result.profileId
          ? catalogProfile(catalog, result.profileId)
          : undefined;
        // A model taken off the list cuts the attempt still running it here,
        // at the proxy's next regrant.
        if (
          !listed ||
          !sessionProfile(listed, {
            fingerprint: result.binding,
            model: result.model,
          })
        ) {
          moved("session's profile");
        }
        return grant(providerUpstreamOf(listed));
      }
      if (result.repository === null) moved("session's repository");
      const { id, url, branch } = result.repository;
      const pair =
        id !== null && result.profileId !== null
          ? allowedPair(catalog, result.profileId, id)
          : null;
      if (
        id === null ||
        pair === null ||
        pair.repository.url !== url ||
        pair.repository.branch !== branch ||
        repositoryBinding(id, pair.repository) !== result.binding
      ) {
        moved("session's repository");
      }
      const forge = deps.forges?.(id) ?? null;
      if (forge === null) {
        if (pair.repository.auth?.kind === "github_app") forgeUnavailable();
        return grant(repositoryUpstreamOf(pair.repository));
      }
      const repo = repoRefOf(url);
      if (repo === null) forgeUnavailable();
      let issued: GitCredential;
      try {
        issued = await forge.gitCredential(repo, "read");
      } catch {
        // The adapter logs why; nothing of its error reaches the proxy.
        forgeUnavailable();
      }
      return grant(repositoryUpstreamOf(pair.repository, issued));
    },

    // What one Messages call through the provider route used, as the proxy
    // read it off the answer. This is the session's spend: the
    // engine's calls and any a tool made with the engine's token alike.
    async recordProviderUsage(report: {
      exchangeId: string;
      sessionId: string;
      attemptId: string;
      usage: ProviderUsage;
    }): Promise<{ costUsd: number; pricedBy: PricedBy }> {
      // Decided by the session row, never by the model the answer names
      // (the upstream's to pick) or by this API's catalog (another replica's
      // may differ mid-rollout).
      const result = await work.recordProviderUsageAtomic({
        ...report,
        priceFor: (session) =>
          session.unmetered
            ? { costUsd: 0, pricedBy: "unmetered" }
            : priceProviderUsage(report.usage),
      });
      if (result.outcome === "unknown_attempt") {
        throw new WorkerGatewayError(
          404,
          "NOT_FOUND",
          "No such attempt of that session",
        );
      }
      if (result.outcome === "conflict") {
        throw new WorkerGatewayError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "That exchange was reported with other usage",
        );
      }
      return { costUsd: result.costUsd, pricedBy: result.pricedBy };
    },

    async nextInput(
      principal: WorkerPrincipal,
      request: NextInputRequest,
    ): Promise<NextInputResponse> {
      const fence = requireScope(principal, request);
      const deadline =
        now().getTime() + Math.min(request.wait_ms ?? 0, maxWaitMs);
      for (;;) {
        const result = await work.nextInputAtomic({
          fence,
          now: now(),
          costLimitUsd: deps.options.sessionCostLimitUsd,
          tokenLimit,
        });
        if (result.outcome !== "ok") rejected(result);
        // A draining attempt is never handed new input, and neither is a
        // session over budget, so waiting out the poll would only hold up
        // the shutdown.
        if (
          result.input ||
          result.draining === true ||
          result.blocked !== undefined ||
          deps.options.stopWaiting?.aborted === true ||
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
            ...(result.blocked !== undefined
              ? { draining: true, reason: result.blocked }
              : result.draining === true
                ? { draining: true }
                : {}),
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
        lease_remaining_ms: result.leaseRemainingMs,
        auth_revision: result.authRevision,
        // A hint, read after the fenced write: the worker's pendingControl
        // poll is what actually hands anything over. A failed read must not
        // turn the lease already renewed into an error the worker reads as
        // lost; the next beat reads it again.
        control_pending:
          (await pending?.hasUndelivered(fence).catch(() => false)) ?? false,
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
        ...(request.announce === undefined
          ? {}
          : { announce: request.announce }),
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
      if (result.outcome === "turn_interrupted") {
        throw new WorkerGatewayError(
          409,
          "REQUEST_STALE",
          "The turn is being interrupted and takes no new requests",
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
      // Only a turn resumed from a park reports these, and this server
      // resumes none yet: refused rather than dropped, so the receipts they
      // would settle are never left looking settled.
      if (request.delivered !== undefined) {
        throw new WorkerGatewayError(
          400,
          "BAD_REQUEST",
          "This server resumes no parked turn, so it takes no delivery reports",
        );
      }
      const result = await requirePending().pendingControlAtomic({
        fence,
        answersAfter: request.answers_after,
        settled: request.settled ?? [],
      });
      if (result.outcome !== "ok") return rejected(result);
      return {
        control:
          result.control === null
            ? null
            : {
                control_id: result.control.controlId,
                kind: result.control.kind,
                target_turn_id: result.control.turnId,
                issued_at: result.control.issuedAt.toISOString(),
              },
        answers: result.answers.map((item) => ({
          sequence: item.sequence,
          answer: item.answer,
          input_hash: item.inputHash,
        })),
      };
    },

    async parkDeclined(
      principal: WorkerPrincipal,
      request: ParkDeclinedRequest,
    ): Promise<ParkDeclinedResponse> {
      const fence = requireScope(principal, request);
      const result = await requirePending().parkDeclinedAtomic({
        fence,
        pauseControlId: request.pause_control_id,
        reason: request.reason,
      });
      if (result.outcome !== "ok") return rejected(result);
      return { reverted: result.reverted };
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
        costLimitUsd: deps.options.sessionCostLimitUsd,
        tokenLimit,
      };
      // A finalize that already committed is answered from the stored turn.
      // Re-verifying its checkpoint could fail for a reason that has nothing
      // to do with this turn, and the worker has no other way to learn a
      // result that is already durable.
      const settled = await work.peekFinalizeAtomic(attempt);
      if (settled.outcome !== "open") return finalizeAnswer(settled);
      let checkpointVersionsHeld = false;
      let checkpointTranscriptBytes: number | undefined;
      let checkpointOutputs: readonly CheckpointOutputObject[] | undefined;
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
          // A transcript past the limits is where the engine session stands,
          // not a fault of this upload: recorded before the refusal, so the
          // session takes no new turn whatever the worker reports next.
          if (verdict.limit !== undefined) {
            const state = await work.checkpointStateAtomic({
              fence,
              now: now(),
              pendingReason: verdict.limit,
            });
            if (state.outcome !== "ok") rejected(state);
          }
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `Checkpoint manifest rejected: ${verdict.reason}`,
          );
        }
        checkpointVersionsHeld = verdict.versionsHeld === true;
        checkpointTranscriptBytes = verdict.transcriptBytes;
        checkpointOutputs = verdict.outputs;
      }
      // Verification is a network call that can outlast the lease, so the
      // fence is judged against the clock at commit time, not the one this
      // request started with.
      const finalized = await work.finalizeAtomic({
        ...attempt,
        checkpointVersionsHeld,
        ...(checkpointTranscriptBytes === undefined
          ? {}
          : { checkpointTranscriptBytes }),
        ...(checkpointOutputs === undefined ? {} : { checkpointOutputs }),
        now: now(),
      });
      // Not awaited: naming the session must never hold up its turn.
      if (
        deps.titles !== undefined &&
        finalized.outcome === "finalized" &&
        finalized.result.status === "completed" &&
        request.turn_id === FIRST_TURN_ID
      ) {
        void deps.titles.titler.afterFirstTurn({
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
        });
      }
      return finalizeAnswer(finalized);
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
          ...(request.alternate_profile_sha256s === undefined
            ? {}
            : { alternateProfileSha256s: request.alternate_profile_sha256s }),
          sessionId: fence.sessionId,
          // A pointer the claim did not hand out is not one to restore: a
          // retired one belongs to the engine session start_fresh gave up.
          pointer: state.restorable ? state.pointer : null,
        }),
      );
      // A refusal is the end of a resume from `paused` that stands on this
      // pointer; the session is handed to an operator in its own fenced
      // transaction, rechecked there. Any other session is left alone.
      const refusal =
        result.status === "ready"
          ? null
          : result.status === "none"
            ? "no committed checkpoint to restore"
            : result.status === "unavailable"
              ? result.reason
              : `the checkpoint is incompatible with this worker: ${result.mismatches
                  .map((m) => `${m.field} ${m.expected} != ${m.found}`)
                  .join(", ")}`;
      if (refusal !== null) {
        const failed = await work.failResumeAtomic({
          fence,
          now: now(),
          pointerRevision: state.pointer?.revision ?? null,
          error: {
            code: "CHECKPOINT_UNAVAILABLE",
            message: `the resume could not restore its checkpoint: ${refusal}`,
          },
        });
        if (failed.outcome !== "ok") rejected(failed);
        return restorePlanOnWire(result);
      }
      if (result.status !== "ready") return restorePlanOnWire(result);
      // A ready plan exists only with a pointer: "none" answered above.
      const pointerRevision =
        state.pointer?.revision ??
        result.plan.fallback?.pointerRevision ??
        result.plan.revision;
      const fallback = result.plan.fallback;
      if (fallback !== undefined) {
        // A resume from `paused` promised the pointer's state; an older one
        // is not that resume, so the owner decides (with).
        // A session that is not resuming takes the fallback as before.
        const failed = await work.failResumeAtomic({
          fence,
          now: now(),
          pointerRevision,
          error: {
            code: "CHECKPOINT_UNAVAILABLE",
            message: `the resume could not restore its checkpoint: revision ${pointerRevision} is damaged and only revision ${result.plan.revision} verifies`,
          },
        });
        if (failed.outcome !== "ok") rejected(failed);
        else if (failed.failed) {
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `Revision ${pointerRevision} is damaged; the resume it was to restore is handed to an operator rather than resumed from revision ${result.plan.revision}`,
          );
        }
      }
      const recorded = await work.recordRestoreBaseAtomic({
        fence,
        now: now(),
        pointerRevision,
        fallback:
          fallback === undefined
            ? null
            : { revision: result.plan.revision, skipped: fallback.skipped },
      });
      switch (recorded.outcome) {
        case "ok":
          return restorePlanOnWire(result);
        case "pointer_moved":
          throw new WorkerGatewayError(
            409,
            "REVISION_CONFLICT",
            `The checkpoint pointer moved to ${recorded.currentRevision ?? "none"} while the plan was judged; ask for the plan again`,
          );
        case "base_changed":
          throw new WorkerGatewayError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            `This attempt was already handed revision ${recorded.recordedRevision} to restore; a new attempt must start over`,
          );
        default:
          return rejected(recorded);
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
        ...(request.pause_control_id === undefined
          ? {}
          : { pauseControlId: request.pause_control_id }),
        ...(request.stop_kind === "drain" ? { drained: true } : {}),
      });
      if ("refused" in result) {
        switch (result.refused) {
          case "pause_stale":
            throw new WorkerGatewayError(
              409,
              "REQUEST_STALE",
              "The pause this release answers is no longer the session's open one",
            );
          case "pause_blocked":
            throw new WorkerGatewayError(
              409,
              "CHECKPOINT_UNAVAILABLE",
              `The pause cannot commit yet (${result.reason}); keep the lease`,
            );
          default:
            return rejected({ outcome: "lease_expired" });
        }
      }
      return { released: result.released };
    },

    async ready(
      principal: WorkerPrincipal,
      request: WorkerReadyRequest,
    ): Promise<WorkerReadyResponse> {
      const fence = requireScope(principal, request);
      const result = await work.readyAtomic({
        fence,
        now: now(),
        restoredRevision: request.restored_revision,
      });
      if (result.outcome === "restore_mismatch") {
        throw new WorkerGatewayError(
          409,
          "CHECKPOINT_UNAVAILABLE",
          "The session was not resumed onto the checkpoint this worker restored; the resume failed",
        );
      }
      if (result.outcome !== "ok") rejected(result);
      return { activated: result.activated };
    },
  };
}

export type WorkerGateway = ReturnType<typeof createWorkerGateway>;

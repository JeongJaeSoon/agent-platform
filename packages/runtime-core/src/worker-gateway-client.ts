import type {
  ApiErrorCode,
  AppendEventsRequest,
  AppendEventsResponse,
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
  PendingControlRequest,
  PendingControlResponse,
  ReleaseRequest,
  ReleaseResponse,
  RestorePlanRequest,
  RestorePlanResponse,
} from "@agent-platform/contracts";

// The worker's only door to the control plane. The port stays transport-free
// so gRPC can replace it without touching the loop.
export interface WorkerGatewayClient {
  /** Trades the bootstrap credential for a binding and a session credential. */
  bootstrapClaim(
    request: BootstrapClaimRequest,
  ): Promise<BootstrapClaimResponse>;
  nextInput(request: NextInputRequest): Promise<NextInputResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
  appendEvents(request: AppendEventsRequest): Promise<AppendEventsResponse>;
  /**
   * Answers to the pending requests this attempt registered, plus any control
   * intent aimed at it. The worker polls it while a permission or question is
   * outstanding; `heartbeat.control_pending` is the other trigger.
   */
  pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse>;
  finalize(request: FinalizeRequest): Promise<FinalizeResponse>;
  release(request: ReleaseRequest): Promise<ReleaseResponse>;
}

/**
 * The checkpoint half of the door, kept as its own interface so the worker
 * that ships without a publisher (94S-122) is not asked to implement calls it
 * never makes. The publisher and restorer (94S-246) implement both on the
 * HTTP client and fold this into `WorkerGatewayClient` when they land.
 */
export interface CheckpointGatewayClient {
  /**
   * Where the next checkpoint goes: the server's revision and manifest key
   * for this attempt. Asked before every upload, never derived from the
   * claim's restore pointer.
   */
  requestCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointRequestResponse>;
  /**
   * The committed checkpoint as a download list, judged against what this
   * worker runs. Asked after the claim, before the engine starts.
   */
  restorePlan(request: RestorePlanRequest): Promise<RestorePlanResponse>;
}

// The decisions the gateway itself makes, which a worker loop switches on.
export const WORKER_GATEWAY_DECISIONS = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "LEASE_EXPIRED",
  "STALE_EPOCH",
  "NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "CHECKPOINT_UNAVAILABLE",
  "BACKEND_UNAVAILABLE",
] as const satisfies readonly ApiErrorCode[];

export type WorkerGatewayDecision = (typeof WORKER_GATEWAY_DECISIONS)[number];

// What a response may carry, which is more: a rejected body, an oversized
// one or a failing dependency is answered by the shared request pipeline, so
// a client that decodes exhaustively has to accept every shared code.
export type WorkerGatewayErrorCode = ApiErrorCode;

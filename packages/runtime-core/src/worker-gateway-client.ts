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
  RegisterPendingRequest,
  RegisterPendingResponse,
  ReleaseRequest,
  ReleaseResponse,
  RestorePlanRequest,
  RestorePlanResponse,
  WorkerReadyRequest,
  WorkerReadyResponse,
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
   * Makes a permission or question the engine is waiting on visible to
   * clients. Called before anyone is told about it, and retried under the
   * same request id until it lands.
   */
  registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse>;
  /**
   * Answers to the pending requests this attempt registered, plus any control
   * intent aimed at it. The worker polls it while a permission or question is
   * outstanding; `heartbeat.control_pending` is the other trigger.
   */
  pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse>;
  /**
   * Once the claim's restore is done and the engine has loaded it, before
   * the first input poll: a session resumed out of `paused` only admits input
   * again on this report.
   */
  ready(request: WorkerReadyRequest): Promise<WorkerReadyResponse>;
  /**
   * Where the next checkpoint goes: the server's revision and manifest key
   * for this publish. Asked before every upload, never derived from the
   * claim's restore pointer. A rejected preparation is sent too: the server
   * records the refusals that outlive the turn as the session's pending
   * reason.
   */
  requestCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointRequestResponse>;
  /**
   * The committed checkpoint judged against what this worker runs. Asked
   * after the claim, before the engine starts.
   */
  restorePlan(request: RestorePlanRequest): Promise<RestorePlanResponse>;
  finalize(request: FinalizeRequest): Promise<FinalizeResponse>;
  release(request: ReleaseRequest): Promise<ReleaseResponse>;
}

// What a response may carry, which is more: a rejected body, an oversized
// one or a failing dependency is answered by the shared request pipeline, so
// a client that decodes exhaustively has to accept every shared code.
export type WorkerGatewayErrorCode = ApiErrorCode;

/**
 * A call the gateway answered with something other than success. `code` is
 * null when the answer was not an API error body at all — a proxy page, an
 * unrouted path, or a socket that never produced one.
 */
export class WorkerGatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: WorkerGatewayErrorCode | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkerGatewayRequestError";
  }
}

/** Codes that mean this attempt no longer owns the session and must stop. */
export const OWNERSHIP_LOST_CODES: ReadonlySet<WorkerGatewayErrorCode> =
  new Set<WorkerGatewayErrorCode>([
    "LEASE_EXPIRED",
    "STALE_EPOCH",
    "FORBIDDEN",
    "UNAUTHORIZED",
  ]);

export function isOwnershipLost(error: unknown): boolean {
  return (
    error instanceof WorkerGatewayRequestError &&
    error.code !== null &&
    OWNERSHIP_LOST_CODES.has(error.code)
  );
}

export function isRetryable(error: unknown): boolean {
  return (
    error instanceof WorkerGatewayRequestError &&
    error.retryable &&
    !isOwnershipLost(error)
  );
}

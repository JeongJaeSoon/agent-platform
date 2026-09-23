import {
  type ApiErrorCode,
  type AppendEventsRequest,
  type AppendEventsResponse,
  apiErrorResponseSchema,
  appendEventsResponseSchema,
  type BootstrapClaimRequest,
  type BootstrapClaimResponse,
  bootstrapClaimResponseSchema,
  type CheckpointRequest,
  type CheckpointRequestResponse,
  checkpointRequestResponseSchema,
  type FinalizeRequest,
  type FinalizeResponse,
  finalizeResponseSchema,
  type HeartbeatRequest,
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type NextInputRequest,
  type NextInputResponse,
  nextInputResponseSchema,
  type PendingControlRequest,
  type PendingControlResponse,
  pendingControlResponseSchema,
  type RegisterPendingRequest,
  type RegisterPendingResponse,
  type ReleaseRequest,
  type ReleaseResponse,
  type RestorePlanRequest,
  type RestorePlanResponse,
  registerPendingResponseSchema,
  releaseResponseSchema,
  restorePlanResponseSchema,
  type WorkerReadyRequest,
  type WorkerReadyResponse,
  workerReadyResponseSchema,
} from "@agent-platform/contracts";

import type { WorkerGatewaySession } from "./worker-host.ts";

/**
 * A call the gateway answered with something other than success. `code` is
 * null when the answer was not an API error body at all — a proxy page, an
 * unrouted path, or a socket that never produced one.
 */
export class WorkerGatewayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | null,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkerGatewayRequestError";
  }
}

/** Codes that mean this attempt no longer owns the session and must stop. */
const OWNERSHIP_LOST = new Set<ApiErrorCode>([
  "LEASE_EXPIRED",
  "STALE_EPOCH",
  "FORBIDDEN",
  "UNAUTHORIZED",
]);

export function isOwnershipLost(error: unknown): boolean {
  return (
    error instanceof WorkerGatewayRequestError &&
    error.code !== null &&
    OWNERSHIP_LOST.has(error.code)
  );
}

export function isRetryable(error: unknown): boolean {
  return (
    error instanceof WorkerGatewayRequestError &&
    error.retryable &&
    !isOwnershipLost(error)
  );
}

// Only what a response body has to answer, so the worker never imports zod.
type Decoder<T> = { parse(value: unknown): T };

/** Only the call this client makes, so a test double need not be a whole fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type HttpWorkerGatewayClientOptions = {
  baseUrl: string;
  /** The launch nonce to start with; `useCredential` swaps in the session token. */
  credential: string;
  fetch?: FetchLike;
  requestTimeoutMs: number;
};

/**
 * The client half of the worker protocol 94S-121 serves. The API mounts it
 * under `/internal`, and the launcher hands out the bare origin, so the
 * prefix is this client's to add. The worker
 * container reaches the gateway through the egress proxy, which fetch reads
 * out of the proxy environment variables the launcher sets; nothing here
 * addresses the daemon host.
 */
export class HttpWorkerGatewayClient implements WorkerGatewaySession {
  private credential: string;
  private readonly baseUrl: string;
  private readonly call: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpWorkerGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.credential = options.credential;
    this.call =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  useCredential(credential: string): void {
    this.credential = credential;
  }

  bootstrapClaim(
    request: BootstrapClaimRequest,
  ): Promise<BootstrapClaimResponse> {
    return this.post("/bootstrap-claim", request, bootstrapClaimResponseSchema);
  }

  nextInput(request: NextInputRequest): Promise<NextInputResponse> {
    return this.post("/next-input", request, nextInputResponseSchema);
  }

  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.post("/heartbeat", request, heartbeatResponseSchema);
  }

  appendEvents(request: AppendEventsRequest): Promise<AppendEventsResponse> {
    return this.post("/append-events", request, appendEventsResponseSchema);
  }

  registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse> {
    return this.post(
      "/register-pending",
      request,
      registerPendingResponseSchema,
    );
  }

  pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse> {
    return this.post("/pending-control", request, pendingControlResponseSchema);
  }

  requestCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointRequestResponse> {
    return this.post(
      "/checkpoint-request",
      request,
      checkpointRequestResponseSchema,
    );
  }

  restorePlan(request: RestorePlanRequest): Promise<RestorePlanResponse> {
    return this.post("/restore-plan", request, restorePlanResponseSchema);
  }

  ready(request: WorkerReadyRequest): Promise<WorkerReadyResponse> {
    return this.post("/ready", request, workerReadyResponseSchema);
  }

  finalize(request: FinalizeRequest): Promise<FinalizeResponse> {
    return this.post("/finalize", request, finalizeResponseSchema);
  }

  release(request: ReleaseRequest): Promise<ReleaseResponse> {
    return this.post("/release", request, releaseResponseSchema);
  }

  private async post<T>(
    path: string,
    body: unknown,
    decoder: Decoder<T>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.call(`${this.baseUrl}/internal/worker${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      // A socket that never answered says nothing about whether the write
      // landed, so it is retryable and the caller replays the idempotent key.
      throw new WorkerGatewayRequestError(
        0,
        null,
        `POST ${path} did not reach the gateway: ${message(error)}`,
        true,
      );
    }
    const payload = await readJson(response);
    if (!response.ok) throw failure(path, response.status, payload);
    try {
      return decoder.parse(payload);
    } catch (error) {
      throw new WorkerGatewayRequestError(
        response.status,
        null,
        `POST ${path} answered a body this worker cannot read: ${message(error)}`,
        false,
      );
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function failure(
  path: string,
  status: number,
  payload: unknown,
): WorkerGatewayRequestError {
  const parsed = apiErrorResponseSchema.safeParse(payload);
  if (!parsed.success) {
    // 5xx without a body is still the gateway being unavailable rather than
    // this request being wrong, so it stays retryable.
    return new WorkerGatewayRequestError(
      status,
      null,
      `POST ${path} failed with HTTP ${status}`,
      status >= 500 || status === 429,
    );
  }
  const { code, message: detail, retryable } = parsed.data.error;
  return new WorkerGatewayRequestError(
    status,
    code,
    `POST ${path} failed with ${code}: ${detail}`,
    retryable,
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

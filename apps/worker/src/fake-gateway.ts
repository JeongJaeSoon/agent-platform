import type {
  ApiErrorCode,
  AppendEventsRequest,
  AppendEventsResponse,
  BootstrapClaimRequest,
  BootstrapClaimResponse,
  CheckpointRef,
  FinalizeRequest,
  FinalizeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  NextInputRequest,
  NextInputResponse,
  PendingControlRequest,
  PendingControlResponse,
  PostSessionAnswerRequest,
  ReleaseRequest,
  ReleaseResponse,
  SessionRuntime,
  WorkerEvent,
} from "@agent-platform/contracts";

import { WorkerGatewayRequestError } from "./gateway-client.ts";
import type { WorkerGatewaySession } from "./worker-host.ts";

export type FakeWorkerGatewayOptions = {
  attemptId?: string;
  /** Where this session's turn numbering carries on from. */
  firstTurn?: number;
  leaseTtlMs?: number;
  restore?: CheckpointRef | null;
  runtime?: SessionRuntime;
  sessionId?: string;
};

type Queued = { inputId: string; message: string; turnId: string };

/**
 * An in-memory stand-in for the Worker Gateway that keeps the parts of the
 * protocol a worker can get wrong: the event stream refuses a gap the way the
 * real `commitEventsAtomic` does, finalize is idempotent per key, and answers
 * only come back through `pendingControl`.
 *
 * It ships next to the worker rather than in testkit because the direct-local
 * suite and the unit suite both drive it, and testkit may not be a runtime
 * dependency of an app.
 */
export class FakeWorkerGateway implements WorkerGatewaySession {
  readonly batches: AppendEventsRequest[] = [];
  readonly calls: string[] = [];
  readonly events: WorkerEvent[] = [];
  readonly finalized: FinalizeRequest[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  readonly releases: ReleaseRequest[] = [];
  credential: string | undefined;
  /** Set to make the next heartbeat answer with this code. */
  heartbeatFailure: ApiErrorCode | undefined;
  /** Reported back by every heartbeat; raising it fences the worker out. */
  authRevision = 0;
  /**
   * What the gateway does for a draining attempt: hand it no new input.
   * Cleared, it stands in for a poll that read the queue before the draining
   * heartbeat committed.
   */
  refuseDraining = true;
  private draining = false;
  /** Thrown by every append while set. */
  appendFailure: WorkerGatewayRequestError | undefined;

  private readonly answers: Array<{
    answer: PostSessionAnswerRequest;
    sequence: number;
  }> = [];
  private readonly options: Required<
    Omit<FakeWorkerGatewayOptions, "restore">
  > &
    Pick<FakeWorkerGatewayOptions, "restore">;
  private readonly queue: Queued[] = [];
  private acceptedThrough = 0;
  private nextTurn: number;
  private waiting: Array<() => void> = [];

  constructor(options: FakeWorkerGatewayOptions = {}) {
    this.nextTurn = options.firstTurn ?? 1;
    this.options = {
      attemptId: options.attemptId ?? "att_fake",
      firstTurn: options.firstTurn ?? 1,
      leaseTtlMs: options.leaseTtlMs ?? 30_000,
      restore: options.restore ?? null,
      runtime: options.runtime ?? {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        profile_id: "fake-profile",
      },
      sessionId: options.sessionId ?? "11111111-1111-4111-8111-111111111111",
    };
  }

  /** Puts one message on the session queue and returns the turn it became. */
  enqueue(message: string): string {
    const turnId = String(this.nextTurn);
    this.nextTurn += 1;
    this.queue.push({ inputId: `msg-${turnId}`, message, turnId });
    for (const wake of this.waiting.splice(0)) wake();
    return turnId;
  }

  /** Makes an answer available to the next `pendingControl` poll. */
  answer(answer: PostSessionAnswerRequest): void {
    this.answers.push({ answer, sequence: this.answers.length + 1 });
  }

  /** The `question` events this attempt registered, in stream order. */
  questions(): WorkerEvent[] {
    return this.events.filter((event) => event.event === "question");
  }

  useCredential(credential: string): void {
    this.credential = credential;
    this.calls.push("useCredential");
  }

  async bootstrapClaim(
    request: BootstrapClaimRequest,
  ): Promise<BootstrapClaimResponse> {
    this.calls.push("bootstrapClaim");
    return {
      session_id: this.options.sessionId,
      turn_id: null,
      attempt_id: this.options.attemptId,
      lease_epoch: 1,
      execution_generation: request.execution_generation,
      auth_revision: this.authRevision,
      session_credential: "wsc_fake",
      lease_expires_at: this.leaseExpiresAt(),
      runtime: this.options.runtime,
      restore: this.options.restore ?? null,
    };
  }

  async nextInput(request: NextInputRequest): Promise<NextInputResponse> {
    this.calls.push("nextInput");
    if (this.queue.length === 0 && (request.wait_ms ?? 0) > 0) {
      await Promise.race([
        new Promise<void>((resolve) => this.waiting.push(resolve)),
        Bun.sleep(request.wait_ms ?? 0),
      ]);
    }
    const next =
      this.draining && this.refuseDraining ? undefined : this.queue.shift();
    return {
      input:
        next === undefined
          ? null
          : {
              turn_id: next.turnId,
              input_id: next.inputId,
              message: next.message,
              delivery_started_at: new Date().toISOString(),
            },
      lease_expires_at: this.leaseExpiresAt(),
    };
  }

  async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    this.calls.push("heartbeat");
    this.heartbeats.push(request);
    if (request.attempt_state === "draining") this.draining = true;
    if (this.heartbeatFailure !== undefined) {
      throw new WorkerGatewayRequestError(
        409,
        this.heartbeatFailure,
        `heartbeat failed with ${this.heartbeatFailure}`,
        false,
      );
    }
    return {
      lease_expires_at: this.leaseExpiresAt(),
      auth_revision: this.authRevision,
      control_pending: false,
    };
  }

  async appendEvents(
    request: AppendEventsRequest,
  ): Promise<AppendEventsResponse> {
    this.calls.push("appendEvents");
    if (this.appendFailure !== undefined) throw this.appendFailure;
    for (const event of request.events) {
      if (event.source_sequence !== this.acceptedThrough + 1) {
        throw new WorkerGatewayRequestError(
          400,
          "BAD_REQUEST",
          `Events must continue the durable prefix; resume from source_sequence ${this.acceptedThrough + 1}`,
          false,
        );
      }
      this.acceptedThrough = event.source_sequence;
      this.events.push(event);
    }
    this.batches.push(request);
    return {
      accepted_through: this.acceptedThrough,
      cursor: `cursor-${this.acceptedThrough}`,
    };
  }

  async pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse> {
    this.calls.push("pendingControl");
    return {
      control: null,
      answers: this.answers.filter(
        (entry) => entry.sequence > request.answers_after,
      ),
    };
  }

  async finalize(request: FinalizeRequest): Promise<FinalizeResponse> {
    this.calls.push("finalize");
    const replay = this.finalized.find(
      (earlier) => earlier.finalize_key === request.finalize_key,
    );
    if (replay === undefined) this.finalized.push(request);
    return {
      turn_id: request.turn_id,
      status: request.terminal.status,
      checkpoint_revision: request.checkpoint?.revision ?? null,
    };
  }

  async release(request: ReleaseRequest): Promise<ReleaseResponse> {
    this.calls.push("release");
    this.releases.push(request);
    return { released: true };
  }

  private leaseExpiresAt(): string {
    return new Date(Date.now() + this.options.leaseTtlMs).toISOString();
  }
}

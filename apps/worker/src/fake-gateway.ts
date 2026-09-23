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
  PendingSettlement,
  PostSessionAnswerRequest,
  RegisterPendingRequest,
  RegisterPendingResponse,
  ReleaseRequest,
  ReleaseResponse,
  RuntimeConfig,
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
  runtimeConfig?: RuntimeConfig;
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
  /** Every registration that landed, in order, keyed by nothing: replays repeat. */
  readonly registrations: RegisterPendingRequest[] = [];
  /** How each registered request ended, as the worker reported it. */
  readonly settled: PendingSettlement[] = [];
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
  /** Thrown by every first-time finalize while set. */
  finalizeFailure: WorkerGatewayRequestError | undefined;

  private readonly answers: Array<{
    answer: PostSessionAnswerRequest;
    sequence: number;
    input_hash: string;
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
      runtimeConfig: options.runtimeConfig ?? {
        model: "fake-model",
        tools: [],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: "http://127.0.0.1:4000",
          auth: { kind: "api_key", value: "placeholder" },
        },
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

  /**
   * Makes an answer available to the next `pendingControl` poll, bound to
   * the arguments the request was registered with, as the real one is.
   */
  answer(answer: PostSessionAnswerRequest): void {
    const registered = this.registrations.find(
      (entry) => entry.request_id === answer.request_id,
    );
    this.answers.push({
      answer,
      sequence: this.answers.length + 1,
      input_hash: registered?.input_hash ?? "0".repeat(64),
    });
  }

  /** The id the worker gave the callback the engine raised for this tool use. */
  requestIdFor(toolUseId: string): string {
    const event = this.questions().find(
      (candidate) =>
        candidate.event === "question" &&
        candidate.data.tool_use_id === toolUseId,
    );
    if (event?.event !== "question") {
      throw new Error(`No question event for ${toolUseId}`);
    }
    return event.data.request_id;
  }

  /** The registrations the worker made, newest last, without replays. */
  registered(): RegisterPendingRequest[] {
    return this.registrations.filter(
      (entry, index) =>
        this.registrations.findIndex(
          (other) => other.request_id === entry.request_id,
        ) === index,
    );
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
      runtime_config: this.options.runtimeConfig,
      workspace: {
        repository: {
          id: "fake-repository",
          url: "https://git.example.test/fake.git",
          branch: "main",
        },
      },
      restore: this.options.restore ?? null,
    };
  }

  async nextInput(request: NextInputRequest): Promise<NextInputResponse> {
    this.calls.push("nextInput");
    // Like the real gateway, a draining attempt's poll comes back at once.
    const handsNothing = this.draining && this.refuseDraining;
    if (
      !handsNothing &&
      this.queue.length === 0 &&
      (request.wait_ms ?? 0) > 0
    ) {
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
    if (request.attempt_state === "draining") {
      this.draining = true;
      if (this.refuseDraining) {
        for (const wake of this.waiting.splice(0)) wake();
      }
    }
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

  async registerPending(
    request: RegisterPendingRequest,
  ): Promise<RegisterPendingResponse> {
    this.calls.push("registerPending");
    this.registrations.push(request);
    return {
      request_id: request.request_id,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      expires_in_ms: 30 * 60_000,
    };
  }

  async pendingControl(
    request: PendingControlRequest,
  ): Promise<PendingControlResponse> {
    this.calls.push("pendingControl");
    for (const item of request.settled ?? []) {
      // Like the real gateway: a request with no row has nothing to settle,
      // and the first word on one stands.
      const known = this.registrations.some(
        (entry) => entry.request_id === item.request_id,
      );
      if (
        known &&
        !this.settled.some((done) => done.request_id === item.request_id)
      ) {
        this.settled.push(item);
      }
    }
    return {
      control: null,
      // Like the real gateway, a settled request is no longer handed out.
      answers: this.answers.filter(
        (entry) =>
          entry.sequence > request.answers_after &&
          !this.settled.some(
            (done) => done.request_id === entry.answer.request_id,
          ),
      ),
    };
  }

  async finalize(request: FinalizeRequest): Promise<FinalizeResponse> {
    this.calls.push("finalize");
    const replay = this.finalized.find(
      (earlier) => earlier.finalize_key === request.finalize_key,
    );
    if (replay === undefined && this.finalizeFailure !== undefined) {
      throw this.finalizeFailure;
    }
    if (replay === undefined) {
      // The same gate finalizeAtomic applies (94S-218); a replay is answered
      // from what was stored, like the real one.
      if (request.final_source_sequence !== this.acceptedThrough) {
        throw new WorkerGatewayRequestError(
          409,
          "REVISION_CONFLICT",
          `Events are durable through source_sequence ${this.acceptedThrough}, not ${request.final_source_sequence}`,
          false,
        );
      }
      this.finalized.push(request);
    }
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

import { randomUUID } from "node:crypto";
import {
  type ControlIntent,
  type ParkedDelivery,
  PENDING_SETTLEMENTS_MAX,
  type PendingQuestion,
  type PendingSettlement,
  type PostSessionAnswerRequest,
  pendingQuestionSchema,
  questionAnswerMismatch,
  type RegisterPendingRequest,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  type AnswerResult,
  type ApprovalDecisionPayload,
  type ApprovalRequested,
  isOwnershipLost,
  isRetryable,
  type ParkedApproval,
  type WorkerGatewayClient,
} from "@werft-ai/runtime-core";

import { settledWithin } from "./waits.ts";

export type PendingRequestsOptions = {
  gateway: Pick<WorkerGatewayClient, "registerPending" | "pendingControl">;
  /**
   * Resolves once the tool call this request is about, and every event
   * published before it, is stored. The gateway writes the `question` event
   * itself when it registers the request, so without this it could land
   * ahead of the call that raised it.
   */
  eventsStored: (toolUseId: string, askedAt: number) => Promise<void>;
  scope: () => WorkerScope;
  /**
   * How long this worker holds a callback the gateway has not registered.
   * Once it has, the gateway's own expiry replaces this, longer or shorter:
   * the installation's PENDING_REQUEST_TTL_SEC is the API's alone.
   */
  timeoutMs: number;
  onOwnershipLost?: (error: unknown) => void;
  /**
   * A control intent the gateway holds for this attempt; repeated each poll
   * until it is settled. `answered` says the same poll applied an answer
   * first, which is what changes a park's premise.
   */
  onControl?: (control: ControlIntent, poll: { answered: boolean }) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Outcome = PendingSettlement["outcome"];

type Pending = {
  kind: "permission" | "question";
  questions: PendingQuestion[];
  /** The arguments as the engine sent them, for a park to keep. */
  rawInput: unknown;
  inputHash: string;
  localId: string;
  /** The gateway holds its row. */
  registered: boolean;
  tool: string;
  toolCallId: string;
  settle: (decision: ApprovalDecisionPayload) => Promise<AnswerResult>;
  /** On `performance.now`: a wall-clock jump must not move it. */
  openedAt: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_REGISTER_BACKOFF_MS = 30_000;

/**
 * The turn's pending-request map. Each `canUseTool` callback is registered
 * with the gateway under an id this worker mints — the gateway writes its
 * `question` event with the row — then held until its own answer arrives — never a single waiting
 * slot, because one assistant message can ask several things at once and
 * answers come back in any order.
 *
 * Nothing here decides on the caller's behalf: an answer that never comes is
 * denied when it expires, and so is one that does not fit the request. How
 * each request ended goes back to the gateway, so the answer's receipt says
 * whether it reached the engine.
 */
export class PendingRequestRegistry {
  private readonly options: PendingRequestsOptions;
  private readonly pending = new Map<string, Pending>();
  // Unsent settlements; a poll removes only what it carried, once it lands.
  private readonly settlements = new Map<string, Outcome>();
  // Answers handed to the run whose outcome waits on what the run says.
  private readonly answering = new Map<string, Promise<void>>();
  // Unsent deliveries of parked answers, resent the same way.
  private readonly deliveries = new Map<string, ParkedDelivery["outcome"]>();
  // Handed to a park: their rows stay open for the turn that resumes them,
  // so nothing this worker learns of them is settled.
  private readonly parked = new Set<string>();
  // Registrations still in flight, including ones whose callback has closed
  // but whose row may or may not exist yet.
  private readonly registering = new Set<Promise<void>>();
  private answersAfter = 0;
  private polling: Promise<void> | undefined;
  private stopped = false;
  private watching = false;
  // A refresh needs a round that starts after it asks, so the loop is woken
  // from its sleep rather than waited out.
  private roundsStarted = 0;
  private roundWaiters: Array<{ round: number; resolve: () => void }> = [];
  private again = false;
  private wakeSleep: (() => void) | undefined;

  constructor(options: PendingRequestsOptions) {
    this.options = options;
  }

  get outstanding(): number {
    return this.pending.size;
  }

  /**
   * Registers one approval the run asked for; `answer` is called at most
   * once, with whatever settles it, and never after `withdraw`. What it
   * resolves with decides whether an answer is reported as answered.
   */
  request(
    request: ApprovalRequested,
    answer: (decision: ApprovalDecisionPayload) => Promise<AnswerResult>,
  ): void {
    if (this.stopped) {
      void answer({
        kind: "cancelled",
        reason: "shutdown",
        message: "This worker is no longer taking requests",
      });
      return;
    }
    const requestId = `req_${randomUUID()}`;
    this.pending.set(requestId, {
      kind: request.kind,
      questions: request.kind === "question" ? request.questions : [],
      rawInput: request.tool.input,
      inputHash: request.inputHash,
      localId: request.localId,
      registered: false,
      tool: request.tool.name,
      toolCallId: request.toolCallId,
      settle: answer,
      openedAt: performance.now(),
      deadline: performance.now() + this.options.timeoutMs,
      timer: undefined,
    });
    this.arm(requestId);
    const registration = this.register(requestId, request).finally(() =>
      this.registering.delete(registration),
    );
    this.registering.add(registration);
  }

  /** The run settled one itself, its call aborted: nothing is answered, the gateway is told. */
  withdraw(localId: string): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.localId === localId) {
        this.drop(requestId, "cancelled");
        return;
      }
    }
  }

  /** Cancels everything still waiting; used by drain and by ownership loss. */
  cancelAll(
    reason: "interrupt" | "refused" | "shutdown",
    message: string,
  ): void {
    for (const requestId of [...this.pending.keys()]) {
      this.close(
        requestId,
        { kind: "cancelled", reason, message },
        "cancelled",
      );
    }
  }

  /**
   * Every request waiting is registered and every outcome owed the gateway
   * has gone out, so the rows a park leaves open are exactly the ones held
   * here.
   */
  get parkReady(): boolean {
    return (
      this.pending.size > 0 &&
      this.registering.size === 0 &&
      this.answering.size === 0 &&
      this.settlements.size === 0 &&
      [...this.pending.values()].every((entry) => entry.registered)
    );
  }

  /**
   * Hands every waiting request to a park: each callback is cancelled for
   * it and none is settled, so its row stays open for the finalize to park.
   * An answer that comes for one later is the resumed turn's to take.
   */
  park(): ParkedApproval[] {
    const parked = this.peekParked();
    const handed = [...this.pending.values()];
    for (const requestId of this.pending.keys()) this.parked.add(requestId);
    this.pending.clear();
    for (const entry of handed) {
      clearTimeout(entry.timer);
      void entry.settle({ kind: "cancelled", reason: "park" });
    }
    return parked;
  }

  /** What `park` would hand over, without touching anything. */
  peekParked(): ParkedApproval[] {
    return [...this.pending].map(([requestId, entry]) => ({
      input: entry.rawInput,
      inputHash: entry.inputHash,
      kind: entry.kind,
      requestId,
      tool: entry.tool,
      toolCallId: entry.toolCallId,
    }));
  }

  /**
   * The park did not take: the turn ended some other way, and what it held
   * is settled as cancelled after all.
   */
  unpark(): void {
    for (const requestId of this.parked) {
      this.settlements.set(requestId, "cancelled");
    }
    this.parked.clear();
    this.poll();
  }

  /** How a parked request's answer reached this turn, resent until a poll lands. */
  deliver(requestId: string, outcome: ParkedDelivery["outcome"]): void {
    this.deliveries.set(requestId, outcome);
    this.poll();
  }

  /** One poll now, answers applied, settled once it has answered or `timeoutMs` has passed. */
  async refresh(timeoutMs: number): Promise<void> {
    const round = new Promise<void>((resolve) => {
      this.roundWaiters.push({ round: this.roundsStarted + 1, resolve });
    });
    this.again = true;
    this.wakeSleep?.();
    this.poll(true);
    await settledWithin(round, timeoutMs);
  }

  /**
   * Gives the registrations still in flight and the settlements still unsent
   * one bounded chance to land, so a shutdown tells the gateway what happened
   * to what it holds instead of leaving receipts unknown.
   */
  async flush(timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    if (this.registering.size > 0) {
      await settledWithin(Promise.all(this.registering), timeoutMs);
    }
    if (this.answering.size > 0) {
      await settledWithin(
        Promise.all(this.answering.values()),
        deadline - performance.now(),
      );
    }
    if (this.settlements.size === 0 && this.deliveries.size === 0) return;
    this.poll();
    if (this.polling !== undefined) {
      await settledWithin(this.polling, deadline - performance.now());
    }
  }

  /**
   * Ends every retry and poll this registry runs. Called once nothing more
   * will be said to the gateway: after the final flush, or on owner loss.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Keeps polling at the answer interval while a turn is in flight, callbacks
   * or not: an interrupt has to reach the turn within seconds, and the
   * heartbeat's hint comes only once per beat.
   */
  watch(on: boolean): void {
    this.watching = on;
    if (on) this.poll(true);
  }

  /**
   * Asks the gateway now rather than at the next interval. `force` asks once
   * even with nothing held here: the gateway can hold an answer for a request
   * whose registration outcome this worker never learned.
   */
  poll(force = false): void {
    if (this.polling !== undefined || this.stopped) return;
    if (
      !force &&
      this.pending.size === 0 &&
      this.settlements.size === 0 &&
      this.deliveries.size === 0
    ) {
      return;
    }
    this.polling = this.pollLoop(force).finally(() => {
      this.polling = undefined;
    });
  }

  private arm(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        this.close(
          requestId,
          {
            kind: "cancelled",
            reason: "expired",
            message: `No answer arrived within ${Math.round((entry.deadline - entry.openedAt) / 1000)}s`,
          },
          "expired",
        );
      },
      Math.max(0, entry.deadline - performance.now()),
    );
  }

  private close(
    requestId: string,
    decision: ApprovalDecisionPayload,
    outcome: Outcome,
  ): void {
    if (outcome !== "answered") {
      void this.drop(requestId, outcome)?.settle(decision);
      return;
    }
    const entry = this.drop(requestId, undefined);
    if (entry === undefined) return;
    // A stale answer never reached the engine. An unknown one may have, and
    // calling it cancelled could hide a tool that ran, so it stays answered.
    const answering = entry
      .settle(decision)
      .then(
        (result): Outcome => (result === "stale" ? "cancelled" : "answered"),
        (): Outcome => "cancelled",
      )
      .then((settled) => {
        this.answering.delete(requestId);
        this.settlements.set(requestId, settled);
        this.poll();
      });
    this.answering.set(requestId, answering);
  }

  /**
   * Ends the request without answering the run; returns what it held.
   * Without an outcome, the caller records one once it knows it.
   */
  private drop(
    requestId: string,
    outcome: Outcome | undefined,
  ): Pending | undefined {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return undefined;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (outcome === undefined) return entry;
    this.settlements.set(requestId, outcome);
    this.poll();
    return entry;
  }

  /** No word for it yet, here or on its way. */
  private unsettled(requestId: string): boolean {
    return !this.settlements.has(requestId) && !this.answering.has(requestId);
  }

  private async register(
    requestId: string,
    request: ApprovalRequested,
  ): Promise<void> {
    const tool = request.tool.name;
    const toolUseId = request.toolCallId;
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // The run's redacted copy is published as it is, so a question that no
    // longer parses is refused rather than shown some other way.
    const shown =
      request.kind === "question"
        ? pendingQuestionSchema.array().min(1).safeParse(request.questions).data
        : undefined;
    if (request.kind === "question" && shown === undefined) {
      this.close(
        requestId,
        {
          kind: "cancelled",
          reason: "refused",
          message: "The question cannot be shown without its redacted values",
        },
        "cancelled",
      );
      return;
    }
    const body: RegisterPendingRequest["request"] =
      request.kind === "permission"
        ? { kind: "permission", tool, input: request.display }
        : { kind: "question", questions: shown ?? [] };
    const turnId = this.options.scope().turn_id;
    if (turnId === null) {
      this.close(
        requestId,
        {
          kind: "cancelled",
          reason: "refused",
          message: "No turn is running to ask in",
        },
        "cancelled",
      );
      return;
    }
    try {
      await this.options.eventsStored(toolUseId, request.askedAt);
    } catch (error) {
      this.close(
        requestId,
        {
          kind: "cancelled",
          reason: "refused",
          message: `The events before this request could not be stored: ${error instanceof Error ? error.message : String(error)}`,
        },
        "cancelled",
      );
      this.settlements.delete(requestId);
      return;
    }
    // Once a call has gone out, a closed callback does not end the loop: the
    // row may exist without this worker knowing, answerable by anyone who
    // lists it. Only an outcome the gateway states — registered, refused, or
    // this worker gone — ends it.
    let sent = false;
    let backoff = interval;
    while (!this.stopped && (sent || this.pending.has(requestId))) {
      sent = true;
      try {
        const response = await this.options.gateway.registerPending({
          ...this.options.scope(),
          turn_id: turnId,
          request_id: requestId,
          input_hash: request.inputHash,
          request: body,
          // Hands the question event to the gateway, so it needs one that
          // reads `announce`: the API ships before the worker image that
          // sends it (the request schema is strict).
          announce: { tool_use_id: toolUseId, tool },
        });
        const entry = this.pending.get(requestId);
        if (entry === undefined) {
          // The settlement may have gone out before the row existed and been
          // ignored; the gateway keeps whichever word reached it first.
          if (this.unsettled(requestId)) {
            this.settlements.set(requestId, "cancelled");
          }
          this.poll();
          return;
        }
        // The server's expiry, not the local timeout: waiting past it only
        // holds the engine for answers that can no longer be given, and
        // giving up before it denies one the owner may still send. The
        // margin lets an answer taken just before it still be picked up.
        entry.registered = true;
        entry.deadline =
          performance.now() + response.expires_in_ms + 2 * interval;
        this.arm(requestId);
        this.poll();
        return;
      } catch (error) {
        if (isOwnershipLost(error)) {
          this.options.onOwnershipLost?.(error);
          this.cancelAll("shutdown", "This worker no longer owns the session");
          this.stop();
          return;
        }
        if (!isRetryable(error)) {
          // A refused call left no row, or found one already settled.
          this.close(
            requestId,
            {
              kind: "cancelled",
              reason: "refused",
              message: `The control plane did not take this request: ${error instanceof Error ? error.message : String(error)}`,
            },
            "cancelled",
          );
          this.settlements.delete(requestId);
          return;
        }
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_REGISTER_BACKOFF_MS);
    }
  }

  private async pollLoop(force: boolean): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let once = force;
    while (
      !this.stopped &&
      (once ||
        this.again ||
        this.watching ||
        this.pending.size > 0 ||
        this.settlements.size > 0 ||
        this.deliveries.size > 0)
    ) {
      once = false;
      this.again = false;
      const round = ++this.roundsStarted;
      // The rest waits for the next poll, which comes at once while any is
      // left.
      let sent = false;
      const batch = [...this.settlements]
        .slice(0, PENDING_SETTLEMENTS_MAX)
        .map(([request_id, outcome]) => ({ request_id, outcome }));
      const delivered = [...this.deliveries]
        .slice(0, PENDING_SETTLEMENTS_MAX)
        .map(([request_id, outcome]) => ({ request_id, outcome }));
      try {
        const response = await this.options.gateway.pendingControl({
          ...this.options.scope(),
          answers_after: this.answersAfter,
          ...(batch.length > 0 ? { settled: batch } : {}),
          ...(delivered.length > 0 ? { delivered } : {}),
        });
        this.forget(batch);
        this.forgetDelivered(delivered);
        sent = true;
        // Answers first: one that came with a park is applied, and the park
        // then judged on what is left waiting.
        let answered = false;
        const answers = [...response.answers].sort(
          (a, b) => a.sequence - b.sequence,
        );
        for (const { sequence, answer, input_hash } of answers) {
          if (sequence <= this.answersAfter) continue;
          this.answersAfter = sequence;
          if (this.apply(answer, input_hash)) answered = true;
        }
        if (response.control !== null) {
          this.options.onControl?.(response.control, { answered });
        }
      } catch (error) {
        if (isOwnershipLost(error)) {
          // Nothing this attempt says will be accepted any more, and the
          // gateway settles what it handed out when the execution is gone.
          this.options.onOwnershipLost?.(error);
          this.cancelAll("shutdown", "This worker no longer owns the session");
          this.settlements.clear();
          this.stop();
          return;
        }
        // Resending would be refused the same way; the answers themselves
        // stay waiting for their own expiry.
        if (!isRetryable(error)) {
          this.forget(batch);
          this.forgetDelivered(delivered);
        }
      }
      this.roundWaiters = this.roundWaiters.filter((waiter) => {
        if (waiter.round > round) return true;
        waiter.resolve();
        return false;
      });
      const backlog =
        sent &&
        (batch.length === PENDING_SETTLEMENTS_MAX ||
          delivered.length === PENDING_SETTLEMENTS_MAX);
      if (
        !backlog &&
        (this.watching ||
          this.pending.size > 0 ||
          this.settlements.size > 0 ||
          this.deliveries.size > 0) &&
        !this.again
      ) {
        await Promise.race([
          sleep(interval),
          new Promise<void>((resolve) => {
            this.wakeSleep = resolve;
          }),
        ]);
        this.wakeSleep = undefined;
      }
    }
  }

  private forget(batch: PendingSettlement[]): void {
    for (const item of batch) {
      if (this.settlements.get(item.request_id) === item.outcome) {
        this.settlements.delete(item.request_id);
      }
    }
  }

  private forgetDelivered(batch: ParkedDelivery[]): void {
    for (const item of batch) {
      if (this.deliveries.get(item.request_id) === item.outcome) {
        this.deliveries.delete(item.request_id);
      }
    }
  }

  /** True when the answer reached its callback as one. */
  private apply(answer: PostSessionAnswerRequest, inputHash: string): boolean {
    if (this.parked.has(answer.request_id)) return false;
    const entry = this.pending.get(answer.request_id);
    if (entry === undefined) {
      // Its callback is already gone: say so, or the receipt would wait on
      // a request nobody holds.
      if (this.unsettled(answer.request_id)) {
        this.settlements.set(answer.request_id, "cancelled");
      }
      return false;
    }
    if (entry.inputHash !== inputHash) {
      this.close(
        answer.request_id,
        {
          kind: "cancelled",
          reason: "refused",
          message: "The answer was given for different tool arguments",
        },
        "cancelled",
      );
      return true;
    }
    if (entry.kind !== answer.kind) {
      this.close(
        answer.request_id,
        {
          kind: "cancelled",
          reason: "refused",
          message: `A ${answer.kind} answer cannot settle a ${entry.kind} request`,
        },
        "cancelled",
      );
      return true;
    }
    if (answer.kind === "permission") {
      this.close(
        answer.request_id,
        answer.decision === "allow"
          ? { kind: "selected", optionKind: "allow_once" }
          : {
              kind: "selected",
              optionKind: "reject_once",
              message: answer.reason ?? "Denied without a reason",
            },
        "answered",
      );
      return true;
    }
    const invalid = questionAnswerMismatch(entry.questions, answer.answers);
    if (invalid !== null) {
      // The gateway refuses these already; acting on one that slipped through
      // would let the engine act on something nobody chose.
      this.close(
        answer.request_id,
        { kind: "cancelled", reason: "refused", message: invalid },
        "cancelled",
      );
      return true;
    }
    this.close(
      answer.request_id,
      { kind: "answered", answers: answer.answers },
      "answered",
    );
    return true;
  }
}

import { createHash, randomUUID } from "node:crypto";
import {
  type ControlIntent,
  canonicalJson,
  PENDING_SETTLEMENTS_MAX,
  type PendingQuestion,
  type PendingSettlement,
  type PostSessionAnswerRequest,
  pendingQuestionSchema,
  type QuestionAnswer,
  questionAnswerMismatch,
  type RegisterPendingRequest,
  type WorkerScope,
} from "@agent-platform/contracts";
import { pendingRequestEvent } from "@agent-platform/runtime-claude";
import {
  isOwnershipLost,
  isRetryable,
  type PermissionDecision,
  type PermissionRequest,
  type WorkerGatewayClient,
} from "@agent-platform/runtime-core";

/** The tool the engine uses to put a question to the person, not to use a capability. */
export const QUESTION_TOOL = "AskUserQuestion";

export type PendingRequestsOptions = {
  gateway: Pick<WorkerGatewayClient, "registerPending" | "pendingControl">;
  /**
   * Resolves once the tool call this request is about, and every event
   * published before it, is stored. The gateway writes the `question` event
   * itself when it registers the request, so without this it could land
   * ahead of the call that raised it.
   */
  eventsStored: (toolUseId: string) => Promise<void>;
  scope: () => WorkerScope;
  /**
   * How long this worker holds a callback the gateway has not registered.
   * Once it has, the gateway's own expiry replaces this, longer or shorter:
   * the installation's PENDING_REQUEST_TTL_SEC is the API's alone (94S-389).
   */
  timeoutMs: number;
  onOwnershipLost?: (error: unknown) => void;
  /** A control intent the gateway holds for this attempt; repeated each poll until it is settled. */
  onControl?: (control: ControlIntent) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Outcome = PendingSettlement["outcome"];

type Pending = {
  kind: "permission" | "question";
  questions: PendingQuestion[];
  input: Record<string, unknown>;
  inputHash: string;
  settle: (decision: PermissionDecision) => void;
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
  // Registrations still in flight, including ones whose callback has closed
  // but whose row may or may not exist yet.
  private readonly registering = new Set<Promise<void>>();
  private answersAfter = 0;
  private polling: Promise<void> | undefined;
  private stopped = false;
  private watching = false;

  constructor(options: PendingRequestsOptions) {
    this.options = options;
  }

  get outstanding(): number {
    return this.pending.size;
  }

  /** Registers one callback and resolves with the decision the SDK gets back. */
  async request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.stopped) {
      return {
        behavior: "deny",
        message: "This worker is no longer taking requests",
      };
    }
    const questions = questionsOf(request);
    const kind = questions === null ? "permission" : "question";
    const inputHash = hashOf(request);
    if (inputHash === null) {
      return {
        behavior: "deny",
        message: "The tool arguments cannot be identified for an approval",
      };
    }
    // Fresh per callback: an engine-side id can come round again, and an
    // answer given for one call must never land on another.
    const requestId = `req_${randomUUID()}`;
    const decision = new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, {
        kind,
        questions: questions ?? [],
        input: request.input,
        inputHash,
        settle: resolve,
        openedAt: Date.now(),
        deadline: Date.now() + this.options.timeoutMs,
        timer: undefined,
      });
    });
    this.arm(requestId);
    // An aborted run must not leave the engine waiting on a person.
    const onAbort = () =>
      this.close(
        requestId,
        {
          behavior: "deny",
          message: "The run stopped before this was answered",
        },
        "cancelled",
      );
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const registration = this.register(
      requestId,
      request,
      questions,
      inputHash,
    ).finally(() => this.registering.delete(registration));
    this.registering.add(registration);
    try {
      return await decision;
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Denies everything still waiting; used by drain and by ownership loss. */
  cancelAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.close(requestId, { behavior: "deny", message: reason }, "cancelled");
    }
  }

  /**
   * Gives the registrations still in flight and the settlements still unsent
   * one bounded chance to land, so a shutdown tells the gateway what happened
   * to what it holds instead of leaving receipts unknown.
   */
  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (this.registering.size > 0) {
      await within(Promise.all(this.registering), timeoutMs);
    }
    if (this.settlements.size === 0) return;
    this.poll();
    if (this.polling !== undefined) {
      await within(this.polling, deadline - Date.now());
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
    if (!force && this.pending.size === 0 && this.settlements.size === 0) {
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
            behavior: "deny",
            message: `No answer arrived within ${Math.round((entry.deadline - entry.openedAt) / 1000)}s`,
          },
          "expired",
        );
      },
      Math.max(0, entry.deadline - Date.now()),
    );
  }

  private close(
    requestId: string,
    decision: PermissionDecision,
    outcome: Outcome,
  ): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    this.settlements.set(requestId, outcome);
    entry.settle(decision);
    this.poll();
  }

  private async register(
    requestId: string,
    request: PermissionRequest,
    questions: PendingQuestion[] | null,
    inputHash: string,
  ): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // The display copy is the redacted one the event carries; the hash above
    // was taken over the real arguments.
    const event = pendingRequestEvent(
      {
        input: questions === null ? request.input : { questions },
        kind: questions === null ? "permission" : "question",
        requestId,
        tool: request.tool,
        toolUseId: request.toolUseId,
      },
      `pending:${requestId}`,
    );
    const display = event.event === "question" ? event.data.input : {};
    // Redaction keeps the shape, so ids still line up with the unredacted
    // copy the answer is turned back into. The gateway publishes this copy
    // as it is, so one that no longer parses is refused rather than
    // replaced with the unredacted questions.
    const shown =
      questions === null
        ? null
        : pendingQuestionSchema
            .array()
            .min(1)
            .safeParse((display as { questions?: unknown }).questions).data;
    if (questions !== null && shown === undefined) {
      this.close(
        requestId,
        {
          behavior: "deny",
          message: "The question cannot be shown without its redacted values",
        },
        "cancelled",
      );
      return;
    }
    const body: RegisterPendingRequest["request"] =
      shown === null || shown === undefined
        ? { kind: "permission", tool: request.tool, input: display }
        : { kind: "question", questions: shown };
    const turnId = this.options.scope().turn_id;
    if (turnId === null) {
      this.close(
        requestId,
        { behavior: "deny", message: "No turn is running to ask in" },
        "cancelled",
      );
      return;
    }
    try {
      await this.options.eventsStored(request.toolUseId);
    } catch (error) {
      this.close(
        requestId,
        {
          behavior: "deny",
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
          input_hash: inputHash,
          request: body,
          // Hands the question event to the gateway, so it needs one that
          // reads `announce`: the API ships before the worker image that
          // sends it (the request schema is strict).
          announce: { tool_use_id: request.toolUseId, tool: request.tool },
        });
        const entry = this.pending.get(requestId);
        if (entry === undefined) {
          // The settlement may have gone out before the row existed and been
          // ignored; the gateway keeps whichever word reached it first.
          if (!this.settlements.has(requestId)) {
            this.settlements.set(requestId, "cancelled");
          }
          this.poll();
          return;
        }
        // The server's expiry, not the local timeout: waiting past it only
        // holds the engine for answers that can no longer be given, and
        // giving up before it denies one the owner may still send. The
        // margin lets an answer taken just before it still be picked up.
        entry.deadline = Date.now() + response.expires_in_ms + 2 * interval;
        this.arm(requestId);
        this.poll();
        return;
      } catch (error) {
        if (isOwnershipLost(error)) {
          this.options.onOwnershipLost?.(error);
          this.cancelAll("This worker no longer owns the session");
          this.stop();
          return;
        }
        if (!isRetryable(error)) {
          // A refused call left no row, or found one already settled.
          this.close(
            requestId,
            {
              behavior: "deny",
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
        this.watching ||
        this.pending.size > 0 ||
        this.settlements.size > 0)
    ) {
      once = false;
      // The rest waits for the next poll, which comes at once while any is
      // left.
      let sent = false;
      const batch = [...this.settlements]
        .slice(0, PENDING_SETTLEMENTS_MAX)
        .map(([request_id, outcome]) => ({ request_id, outcome }));
      try {
        const response = await this.options.gateway.pendingControl({
          ...this.options.scope(),
          answers_after: this.answersAfter,
          ...(batch.length > 0 ? { settled: batch } : {}),
        });
        this.forget(batch);
        sent = true;
        if (response.control !== null) {
          this.options.onControl?.(response.control);
        }
        const answers = [...response.answers].sort(
          (a, b) => a.sequence - b.sequence,
        );
        for (const { sequence, answer, input_hash } of answers) {
          if (sequence <= this.answersAfter) continue;
          this.answersAfter = sequence;
          this.apply(answer, input_hash);
        }
      } catch (error) {
        if (isOwnershipLost(error)) {
          // Nothing this attempt says will be accepted any more, and the
          // gateway settles what it handed out when the execution is gone.
          this.options.onOwnershipLost?.(error);
          this.cancelAll("This worker no longer owns the session");
          this.settlements.clear();
          this.stop();
          return;
        }
        // Resending would be refused the same way; the answers themselves
        // stay waiting for their own expiry.
        if (!isRetryable(error)) this.forget(batch);
      }
      const backlog = sent && batch.length === PENDING_SETTLEMENTS_MAX;
      if (
        !backlog &&
        (this.watching || this.pending.size > 0 || this.settlements.size > 0)
      ) {
        await sleep(interval);
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

  private apply(answer: PostSessionAnswerRequest, inputHash: string): void {
    const entry = this.pending.get(answer.request_id);
    if (entry === undefined) {
      // Its callback is already gone: say so, or the receipt would wait on
      // a request nobody holds.
      if (!this.settlements.has(answer.request_id)) {
        this.settlements.set(answer.request_id, "cancelled");
      }
      return;
    }
    if (entry.inputHash !== inputHash) {
      this.close(
        answer.request_id,
        {
          behavior: "deny",
          message: "The answer was given for different tool arguments",
        },
        "cancelled",
      );
      return;
    }
    if (entry.kind !== answer.kind) {
      this.close(
        answer.request_id,
        {
          behavior: "deny",
          message: `A ${answer.kind} answer cannot settle a ${entry.kind} request`,
        },
        "cancelled",
      );
      return;
    }
    if (answer.kind === "permission") {
      this.close(
        answer.request_id,
        answer.decision === "allow"
          ? { behavior: "allow" }
          : {
              behavior: "deny",
              message: answer.reason ?? "Denied without a reason",
            },
        "answered",
      );
      return;
    }
    const invalid = questionAnswerMismatch(entry.questions, answer.answers);
    if (invalid !== null) {
      // The gateway refuses these already; acting on one that slipped through
      // would let the engine act on something nobody chose.
      this.close(
        answer.request_id,
        { behavior: "deny", message: invalid },
        "cancelled",
      );
      return;
    }
    this.close(
      answer.request_id,
      {
        behavior: "allow",
        updatedInput: {
          ...entry.input,
          // 94S-91 fixed this shape against the real SDK: the answers ride
          // back on the tool input, keyed by the question they answer.
          answers: Object.fromEntries(
            entry.questions.map((question) => [
              question.prompt,
              answerText(
                question,
                answer.answers.find(
                  (item) => item.question_id === question.question_id,
                ) as QuestionAnswer,
              ),
            ]),
          ),
        },
      },
      "answered",
    );
  }
}

async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
    }),
  ]);
  clearTimeout(timer);
}

// Over the arguments the engine will act on, before any redaction: an
// approval is for exactly these, and the display copy cannot tell apart two
// calls that differ only in a redacted value.
function hashOf(request: PermissionRequest): string | null {
  try {
    return createHash("sha256")
      .update(canonicalJson({ tool: request.tool, input: request.input }))
      .digest("hex");
  } catch {
    return null;
  }
}

function answerText(question: PendingQuestion, answer: QuestionAnswer): string {
  // Every id was checked against the question's options by the mismatch check.
  const labels = answer.selected_option_ids.map(
    (id) =>
      question.options.find((candidate) => candidate.option_id === id)?.label ??
      id,
  );
  if (answer.free_text !== undefined) labels.push(answer.free_text);
  return labels.join(", ");
}

/**
 * The questions an `AskUserQuestion` call is asking, or null when the callback
 * is an ordinary permission request. Ids are positional so an answer can only
 * name a question and an option this worker actually offered.
 */
function questionsOf(request: PermissionRequest): PendingQuestion[] | null {
  if (request.tool !== QUESTION_TOOL) return null;
  const raw = request.input.questions;
  if (!Array.isArray(raw)) return null;
  const questions = raw.flatMap((value, index) => {
    if (value === null || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const prompt = typeof item.question === "string" ? item.question : null;
    if (prompt === null) return [];
    const options = Array.isArray(item.options) ? item.options : [];
    return [
      {
        question_id: `q${index}`,
        prompt,
        options: options.flatMap((option, position) => {
          const label =
            option !== null &&
            typeof option === "object" &&
            typeof (option as Record<string, unknown>).label === "string"
              ? ((option as Record<string, unknown>).label as string)
              : null;
          return label === null
            ? []
            : [{ option_id: `q${index}o${position}`, label }];
        }),
        multi_select: item.multiSelect === true,
        allow_free_text: true,
      },
    ];
  });
  return questions.length > 0 ? questions : null;
}

import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJson,
  type PendingQuestion,
  type PendingSettlement,
  type PostSessionAnswerRequest,
  pendingQuestionSchema,
  type QuestionAnswer,
  questionAnswerMismatch,
  type RegisterPendingRequest,
  type SessionEvent,
  type WorkerScope,
} from "@agent-platform/contracts";
import { pendingRequestEvent } from "@agent-platform/runtime-claude";
import type {
  PermissionDecision,
  PermissionRequest,
  WorkerGatewayClient,
} from "@agent-platform/runtime-core";

import { isOwnershipLost, isRetryable } from "./gateway-client.ts";

/** The tool the engine uses to put a question to the person, not to use a capability. */
export const QUESTION_TOOL = "AskUserQuestion";

export type PendingRequestsOptions = {
  gateway: Pick<WorkerGatewayClient, "registerPending" | "pendingControl">;
  /** Puts the `question` event into the same stream the frames go to. */
  publish: (event: SessionEvent) => void;
  scope: () => WorkerScope;
  /**
   * The longest this worker holds a callback, registered or not. Once the
   * gateway says how long answers are taken, the wait never outlasts that.
   */
  timeoutMs: number;
  onOwnershipLost?: (error: unknown) => void;
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
  deadline: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * The turn's pending-request map. Each `canUseTool` callback is registered
 * with the gateway under an id this worker mints, published as a `question`
 * event, then held until its own answer arrives — never a single waiting
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
  private answersAfter = 0;
  private polling: Promise<void> | undefined;

  constructor(options: PendingRequestsOptions) {
    this.options = options;
  }

  get outstanding(): number {
    return this.pending.size;
  }

  /** Registers one callback and resolves with the decision the SDK gets back. */
  async request(request: PermissionRequest): Promise<PermissionDecision> {
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
    void this.register(requestId, request, questions, inputHash);
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
   * Gives the settlements still unsent one bounded chance to land, so a
   * shutdown tells the gateway what happened to the answers it handed out
   * instead of leaving their receipts unknown.
   */
  async flush(timeoutMs: number): Promise<void> {
    if (this.settlements.size === 0) return;
    this.poll();
    const polling = this.polling;
    if (polling === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      polling,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Asks the gateway now rather than at the next interval. */
  poll(): void {
    if (this.polling !== undefined) return;
    if (this.pending.size === 0 && this.settlements.size === 0) return;
    this.polling = this.pollLoop().finally(() => {
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
            message: `No answer arrived within ${Math.round(this.options.timeoutMs / 1000)}s`,
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
    const body: RegisterPendingRequest["request"] =
      questions === null
        ? { kind: "permission", tool: request.tool, input: display }
        : {
            kind: "question",
            // Redaction keeps the shape, so ids still line up with the
            // unredacted copy the answer is turned back into.
            questions:
              pendingQuestionSchema
                .array()
                .safeParse((display as { questions?: unknown }).questions)
                .data ?? questions,
          };
    while (this.pending.has(requestId)) {
      const scope = this.options.scope();
      if (scope.turn_id === null) {
        this.close(
          requestId,
          { behavior: "deny", message: "No turn is running to ask in" },
          "cancelled",
        );
        return;
      }
      try {
        const response = await this.options.gateway.registerPending({
          ...scope,
          turn_id: scope.turn_id,
          request_id: requestId,
          input_hash: inputHash,
          request: body,
        });
        const entry = this.pending.get(requestId);
        if (entry === undefined) {
          // Closed while the registration was in flight, so the settlement
          // may have gone out before the row existed; send it again.
          if (!this.settlements.has(requestId)) {
            this.settlements.set(requestId, "cancelled");
          }
          this.poll();
          return;
        }
        // Waiting past the server's expiry would only hold the engine for
        // answers that can no longer be given; the margin lets an answer
        // taken just before it still be picked up.
        entry.deadline = Math.min(
          entry.deadline,
          Date.now() + response.expires_in_ms + 2 * interval,
        );
        this.arm(requestId);
        this.options.publish(event);
        this.poll();
        return;
      } catch (error) {
        if (isOwnershipLost(error)) {
          this.options.onOwnershipLost?.(error);
          this.cancelAll("This worker no longer owns the session");
          return;
        }
        if (!isRetryable(error)) {
          this.close(
            requestId,
            {
              behavior: "deny",
              message: `The control plane did not take this request: ${error instanceof Error ? error.message : String(error)}`,
            },
            "cancelled",
          );
          return;
        }
      }
      await sleep(interval);
    }
  }

  private async pollLoop(): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    while (this.pending.size > 0 || this.settlements.size > 0) {
      const batch = [...this.settlements].map(([request_id, outcome]) => ({
        request_id,
        outcome,
      }));
      try {
        const response = await this.options.gateway.pendingControl({
          ...this.options.scope(),
          answers_after: this.answersAfter,
          ...(batch.length > 0 ? { settled: batch } : {}),
        });
        this.forget(batch);
        // `control` stays unread until 94S-128 gives the gateway something to
        // put there; no intent can be issued today.
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
          return;
        }
        // Resending would be refused the same way; the answers themselves
        // stay waiting for their own expiry.
        if (!isRetryable(error)) this.forget(batch);
      }
      if (this.pending.size > 0 || this.settlements.size > 0) {
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

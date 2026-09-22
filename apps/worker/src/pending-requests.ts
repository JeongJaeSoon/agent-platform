import type {
  PendingQuestion,
  PostSessionAnswerRequest,
  QuestionAnswer,
  SessionEvent,
  WorkerScope,
} from "@agent-platform/contracts";
import { pendingRequestEvent } from "@agent-platform/runtime-claude";
import type {
  PermissionDecision,
  PermissionRequest,
  WorkerGatewayClient,
} from "@agent-platform/runtime-core";

import { isOwnershipLost } from "./gateway-client.ts";

/** The tool the engine uses to put a question to the person, not to use a capability. */
export const QUESTION_TOOL = "AskUserQuestion";

export type PendingRequestsOptions = {
  gateway: Pick<WorkerGatewayClient, "pendingControl">;
  /** Puts the `question` event into the same stream the frames go to. */
  publish: (event: SessionEvent) => void;
  scope: () => WorkerScope;
  /** Denied once nothing has answered it (DESIGN §6.4: 30 minutes). */
  timeoutMs: number;
  onOwnershipLost?: (error: unknown) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type Pending = {
  kind: "permission" | "question";
  questions: PendingQuestion[];
  input: Record<string, unknown>;
  settle: (decision: PermissionDecision) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * The turn's pending-request map. Each `canUseTool` callback is published as a
 * `question` event, then held until its own answer arrives — never a single
 * waiting slot, because one assistant message can ask several things at once
 * and answers come back in any order.
 *
 * Nothing here decides on the caller's behalf: an answer that never comes is
 * denied when it expires, and so is one whose kind does not match the request.
 */
export class PendingRequestRegistry {
  private readonly options: PendingRequestsOptions;
  private readonly pending = new Map<string, Pending>();
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
    const decision = new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.requestId, {
        kind,
        questions: questions ?? [],
        input: request.input,
        settle: resolve,
      });
    });
    this.options.publish(
      pendingRequestEvent(
        {
          input: kind === "question" ? { questions } : request.input,
          kind,
          requestId: request.requestId,
          tool: request.tool,
          toolUseId: request.toolUseId,
        },
        `pending:${request.requestId}`,
      ),
    );
    this.poll();

    const timer = setTimeout(() => {
      this.close(request.requestId, {
        behavior: "deny",
        message: `No answer arrived within ${Math.round(this.options.timeoutMs / 1000)}s`,
      });
    }, this.options.timeoutMs);
    // An aborted run must not leave the engine waiting on a person.
    const onAbort = () =>
      this.close(request.requestId, {
        behavior: "deny",
        message: "The run stopped before this was answered",
      });
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await decision;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Denies everything still waiting; used by drain and by ownership loss. */
  cancelAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.close(requestId, { behavior: "deny", message: reason });
    }
  }

  private close(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    this.pending.delete(requestId);
    entry.settle(decision);
  }

  private poll(): void {
    if (this.polling !== undefined) return;
    this.polling = this.pollLoop().finally(() => {
      this.polling = undefined;
    });
  }

  private async pollLoop(): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    while (this.pending.size > 0) {
      try {
        const response = await this.options.gateway.pendingControl({
          ...this.options.scope(),
          answers_after: this.answersAfter,
        });
        // `control` stays unread until 94S-128 gives the gateway something to
        // put there; no intent can be issued today.
        for (const { sequence, answer } of response.answers) {
          if (sequence <= this.answersAfter) continue;
          this.answersAfter = Math.max(this.answersAfter, sequence);
          this.apply(answer);
        }
      } catch (error) {
        if (isOwnershipLost(error)) {
          this.options.onOwnershipLost?.(error);
          this.cancelAll("This worker no longer owns the session");
          return;
        }
        // Anything else — including the route not existing until 94S-127
        // serves it — leaves the request waiting for its own expiry.
      }
      if (this.pending.size > 0) await sleep(interval);
    }
  }

  private apply(answer: PostSessionAnswerRequest): void {
    const entry = this.pending.get(answer.request_id);
    if (entry === undefined) return;
    if (entry.kind !== answer.kind) {
      this.close(answer.request_id, {
        behavior: "deny",
        message: `A ${answer.kind} answer cannot settle a ${entry.kind} request`,
      });
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
      );
      return;
    }
    this.close(answer.request_id, {
      behavior: "allow",
      updatedInput: {
        ...entry.input,
        // 94S-91 fixed this shape against the real SDK: the answers ride back
        // on the tool input, keyed by the question they answer.
        answers: Object.fromEntries(
          answer.answers.flatMap((item) => {
            const question = entry.questions.find(
              (candidate) => candidate.question_id === item.question_id,
            );
            if (question === undefined) return [];
            return [[question.prompt, answerText(question, item)]];
          }),
        ),
      },
    });
  }
}

function answerText(question: PendingQuestion, answer: QuestionAnswer): string {
  const labels = answer.selected_option_ids.flatMap((id) => {
    const option = question.options.find(
      (candidate) => candidate.option_id === id,
    );
    return option === undefined ? [] : [option.label];
  });
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

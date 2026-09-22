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

import {
  isOwnershipLost,
  WorkerGatewayRequestError,
} from "./gateway-client.ts";

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
const NO_ANSWER_PATH =
  "This control plane cannot deliver answers yet (pending-control, 94S-127)";

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
  /**
   * The gateway has no pending-control route. Until 94S-127 serves one,
   * nothing can ever answer, and holding the engine for the full timeout
   * would only keep the lease busy before the same denial.
   */
  private unanswerable = false;

  constructor(options: PendingRequestsOptions) {
    this.options = options;
  }

  get outstanding(): number {
    return this.pending.size;
  }

  /** Registers one callback and resolves with the decision the SDK gets back. */
  async request(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.unanswerable) return { behavior: "deny", message: NO_ANSWER_PATH };
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
        if (
          error instanceof WorkerGatewayRequestError &&
          error.status === 404
        ) {
          this.unanswerable = true;
          this.cancelAll(NO_ANSWER_PATH);
          return;
        }
        // Anything else leaves the request waiting for its own expiry.
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
    const invalid = invalidAnswers(entry.questions, answer.answers);
    if (invalid !== null) {
      // Allowing a partial or made-up answer would let the engine act on
      // something nobody chose.
      this.close(answer.request_id, { behavior: "deny", message: invalid });
      return;
    }
    this.close(answer.request_id, {
      behavior: "allow",
      updatedInput: {
        ...entry.input,
        // 94S-91 fixed this shape against the real SDK: the answers ride back
        // on the tool input, keyed by the question they answer.
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
    });
  }
}

/**
 * Why an answer cannot stand for the questions asked, or null when it can:
 * exactly one answer per question, only options that question offered, one
 * of them unless it is multi-select, and free text only where allowed.
 */
function invalidAnswers(
  questions: PendingQuestion[],
  answers: QuestionAnswer[],
): string | null {
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = questions.find(
      (candidate) => candidate.question_id === answer.question_id,
    );
    if (question === undefined) {
      return `No question ${answer.question_id} was asked`;
    }
    if (seen.has(answer.question_id)) {
      return `Question ${answer.question_id} was answered twice`;
    }
    seen.add(answer.question_id);
    const selected = new Set(answer.selected_option_ids);
    if (selected.size !== answer.selected_option_ids.length) {
      return `Question ${answer.question_id} selects an option twice`;
    }
    for (const id of selected) {
      if (!question.options.some((option) => option.option_id === id)) {
        return `Question ${answer.question_id} has no option ${id}`;
      }
    }
    if (!question.multi_select && selected.size > 1) {
      return `Question ${answer.question_id} takes one option`;
    }
    if (answer.free_text !== undefined && !question.allow_free_text) {
      return `Question ${answer.question_id} takes no free text`;
    }
  }
  const missing = questions.find((question) => !seen.has(question.question_id));
  return missing === undefined
    ? null
    : `Question ${missing.question_id} was not answered`;
}

function answerText(question: PendingQuestion, answer: QuestionAnswer): string {
  // Every id was checked against the question's options by invalidAnswers.
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

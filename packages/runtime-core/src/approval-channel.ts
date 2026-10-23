import {
  type AnswerResult,
  type ApprovalAnswer,
  type ApprovalRequested,
  approvalInputHash,
  type RuntimeEventBody,
} from "./runtime-contract.ts";

type Waiting = {
  inputHash: string;
  settle: (answer: ApprovalAnswer) => void;
};

/**
 * The adapter half of the approval round trip, for engines whose native
 * approval is a callback the adapter must hold open: the callback becomes an
 * `approval.requested` event on the run's stream and waits for `answer()`.
 * Each request settles exactly once, and so is resolved exactly once.
 */
export class ApprovalChannel {
  private readonly waiting = new Map<string, Waiting>();
  private readonly settled = new Set<string>();
  private readonly queued: RuntimeEventBody[] = [];
  private wake: (() => void) | undefined;
  private next = 0;

  request(
    request: Omit<ApprovalRequested, "inputHash" | "localId" | "type">,
    signal: AbortSignal,
  ): Promise<ApprovalAnswer> {
    const localId = `approval:${this.next++}`;
    const inputHash = approvalInputHash(request.tool.name, request.tool.input);
    return new Promise<ApprovalAnswer>((resolve) => {
      const cancel = () =>
        this.settle(localId, "runtime", {
          decidedBy: "policy",
          inputHash,
          localId,
          message: "The run stopped before this was answered",
          outcome: "cancelled",
        });
      this.waiting.set(localId, {
        inputHash,
        settle: (answer) => {
          signal.removeEventListener("abort", cancel);
          resolve(answer);
        },
      });
      this.emit({ type: "approval.requested", ...request, inputHash, localId });
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }

  answer(answer: ApprovalAnswer): AnswerResult {
    const waiting = this.waiting.get(answer.localId);
    if (waiting === undefined) {
      return this.settled.has(answer.localId) ? "stale" : "unknown";
    }
    if (waiting.inputHash !== answer.inputHash) return "stale";
    this.settle(answer.localId, answer.decidedBy, answer);
    return "applied";
  }

  cancelAll(message: string): void {
    for (const [localId, waiting] of [...this.waiting]) {
      this.settle(localId, "runtime", {
        decidedBy: "policy",
        inputHash: waiting.inputHash,
        localId,
        message,
        outcome: "cancelled",
      });
    }
  }

  /** Events raised since the last call, in order. */
  drain(): RuntimeEventBody[] {
    return this.queued.splice(0);
  }

  /** Resolves at the next event raised; a fresh promise each call. */
  changed(): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.wake = resolve;
    });
  }

  private settle(
    localId: string,
    decidedBy: "policy" | "runtime" | "user",
    answer: ApprovalAnswer,
  ): void {
    const waiting = this.waiting.get(localId);
    if (waiting === undefined) return;
    this.waiting.delete(localId);
    this.settled.add(localId);
    this.emit({
      type: "approval.resolved",
      decidedBy,
      localId,
      outcome: answer.outcome,
    });
    waiting.settle(answer);
  }

  private emit(event: RuntimeEventBody): void {
    this.queued.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

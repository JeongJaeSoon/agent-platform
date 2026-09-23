import type {
  AgentFrame,
  AgentInput,
  AgentRun,
  AgentRuntime,
  CheckpointLeaseGrant,
  CheckpointPreparation,
  NativeSdkMessage,
  PermissionDecision,
  PermissionRequest,
  RuntimeCapabilities,
  RuntimeHooks,
} from "@agent-platform/runtime-core";

import {
  CLAUDE_RUNTIME_CAPABILITIES,
  type ClaudeRuntimeConfig,
} from "./config.ts";
import { frameFromNativeMessage } from "./mapper.ts";
import type { InterruptedResult } from "./run.ts";
import { type ToolAdmission, TurnLedger } from "./turn-ledger.ts";

export type FakeStep =
  /** Hold until one more input has been sent, the way a real engine waits. */
  | { type: "await-input" }
  | { delayMs: number; type: "delay" }
  | { message: NativeSdkMessage; type: "emit" }
  | { error: Error; type: "error" }
  | { requests: Omit<PermissionRequest, "signal">[]; type: "permissions" }
  /** A tool asking the PreToolUse gate to start, the way the real hook does. */
  | { toolUseId: string; type: "tool-start" }
  /** PostToolUse for a tool that started. */
  | { toolUseId: string; type: "tool-end" };

export type FakeRuntimeOptions = {
  /**
   * Input uuids already in the transcript a resumed run continues. The fake
   * treats a send of one the way the pinned SDK does (94S-242): it answers
   * nothing — no frame, no result — and an interrupt afterwards has nothing
   * to end, so it produces no terminal either.
   */
  resumedTranscript?: string[];
  /** Makes a resumed run's `ready()` reject with this, as an unreadable transcript would. */
  resumeFailure?: string;
};

export class FakeAgentRuntime implements AgentRuntime<ClaudeRuntimeConfig> {
  readonly capabilities: RuntimeCapabilities = CLAUDE_RUNTIME_CAPABILITIES;
  /** Every input the host sent, including ones the engine deduplicated. */
  readonly inputs: AgentInput[] = [];
  readonly permissionDecisions: PermissionDecision[] = [];
  /** What the tool gate answered each tool-start step, in order. */
  readonly toolAdmissions: Array<{
    admission: ToolAdmission;
    toolUseId: string;
  }> = [];

  constructor(
    private readonly steps: FakeStep[],
    private readonly options: FakeRuntimeOptions = {},
  ) {}

  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): AgentRun {
    return new FakeRun(
      this,
      config.correlationId,
      this.steps,
      hooks.onPermission,
      config.resume,
      config.mode === "resume"
        ? new Set(this.options.resumedTranscript ?? [])
        : new Set(),
      config.mode === "resume" ? this.options.resumeFailure : undefined,
    );
  }
}

class FakeRun implements AgentRun {
  private readonly abortController = new AbortController();
  private readonly arrivals: Array<() => void> = [];
  // Replaced after each interrupt: the run outlives it, like the real SDK's.
  private interruptController = new AbortController();
  private readonly ledger: TurnLedger;
  private closed = false;
  private consumedInputs = 0;
  /** Inputs the engine took; a deduplicated send is not one. */
  private acceptedInputs = 0;
  /** Sends the engine ignored because the session already held them. */
  private readonly deduplicated = new Set<string>();
  // First accepted terminal action wins: an interrupt that already returned
  // its receipt still yields its terminal result even if abort() follows.
  private terminal: "aborted" | "interrupted" | undefined;
  /** What the SDK names its results with: the session it resumed or reported. */
  private sessionId: string;

  constructor(
    private readonly runtime: FakeAgentRuntime,
    private readonly correlationId: string,
    private readonly steps: FakeStep[],
    private readonly onPermission: (
      request: PermissionRequest,
    ) => Promise<PermissionDecision>,
    resume: string | undefined,
    private readonly resumed: ReadonlySet<string>,
    private readonly resumeFailure: string | undefined,
  ) {
    this.ledger = new TurnLedger(resume);
    this.sessionId = resume ?? "fake-session";
  }

  async ready(): Promise<void> {
    if (this.resumeFailure !== undefined) throw new Error(this.resumeFailure);
  }

  send(input: AgentInput): void {
    if (this.closed) throw new Error("Input stream is closed");
    const duplicate =
      this.resumed.has(input.uuid) || this.ledger.wasSent(input.uuid);
    this.ledger.queued(input.uuid);
    this.runtime.inputs.push(input);
    if (duplicate) {
      this.deduplicated.add(input.uuid);
      return;
    }
    this.acceptedInputs += 1;
    this.wakeArrivals();
  }

  finishInput(): void {
    this.closed = true;
    this.wakeArrivals();
  }

  async holdsInput(uuid: string): Promise<boolean> {
    return this.resumed.has(uuid) || this.ledger.wasSent(uuid);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const pending = this.ledger.pendingUuids();
    if (
      pending.length > 0 &&
      pending.every((uuid) => this.deduplicated.has(uuid))
    ) {
      // Nothing is running: the only inputs outstanding were never taken.
      return { stillQueued: [] };
    }
    this.terminal ??= "interrupted";
    this.interruptController.abort();
    return { stillQueued: [] };
  }

  abort(): void {
    this.terminal ??= "aborted";
    this.abortController.abort();
  }

  close(): void {
    this.closed = true;
    this.abort();
  }

  async leaseCheckpoint(): Promise<CheckpointLeaseGrant> {
    return this.ledger.leaseCheckpoint();
  }

  async prepareCheckpoint(): Promise<CheckpointPreparation> {
    return this.ledger.prepareCheckpoint();
  }

  events(): AsyncIterable<AgentFrame> {
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentFrame> {
    this.ledger.claimConsumer();
    try {
      let cursor = 0;
      for (let index = 0; index < this.steps.length; index += 1) {
        const step = this.steps[index] as FakeStep;
        const controlSignal = AbortSignal.any([
          this.abortController.signal,
          this.interruptController.signal,
        ]);
        let interrupted = false;
        if (this.terminal === "aborted") throw abortError();
        if (this.terminal === "interrupted") {
          yield this.interruptedFrame(`fake:${cursor}`, index, false);
          interrupted = true;
        } else {
          try {
            await this.runStep(step, controlSignal);
            if (step.type === "emit") {
              this.ledger.observe(step.message);
              if (typeof step.message.session_id === "string") {
                this.sessionId = step.message.session_id;
              }
              yield frameFromNativeMessage(
                step.message,
                this.correlationId,
                `fake:${cursor}`,
              );
            }
          } catch (error) {
            if (this.terminal !== "interrupted") throw error;
          }
          if (this.terminal === "aborted") throw abortError();
          if (this.terminal === "interrupted") {
            yield this.interruptedFrame(
              `fake:${cursor}:interrupted`,
              index,
              true,
            );
            interrupted = true;
          }
        }
        cursor += 1;
        if (!interrupted) continue;
        // The real SDK ends only the current turn: the script resumes at the
        // next turn's input, and ends here when no further turn is scripted.
        const next = this.steps.findIndex(
          (candidate, position) =>
            position > index && candidate.type === "await-input",
        );
        if (next === -1) return;
        this.terminal = undefined;
        this.interruptController = new AbortController();
        index = next - 1;
      }
    } finally {
      this.ledger.streamEnded();
    }
  }

  private async runStep(step: FakeStep, signal: AbortSignal): Promise<void> {
    if (step.type === "await-input") {
      await raceAbort(this.awaitInput(), signal);
    } else if (step.type === "delay") {
      await raceAbort(Bun.sleep(step.delayMs), signal);
    } else if (step.type === "error") {
      throw step.error;
    } else if (step.type === "permissions") {
      const decisions = await raceAbort(
        Promise.all(
          step.requests.map((request) =>
            this.askPermission({ ...request, signal }),
          ),
        ),
        signal,
      );
      this.runtime.permissionDecisions.push(...decisions);
    } else if (step.type === "tool-start") {
      this.runtime.toolAdmissions.push({
        toolUseId: step.toolUseId,
        admission: this.ledger.toolStarting(step.toolUseId),
      });
    } else if (step.type === "tool-end") {
      this.ledger.toolSettled(step.toolUseId);
    }
  }

  /** The same gate the real canUseTool goes through. */
  private async askPermission(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const admission = this.ledger.permissionStarting();
    if (!admission.allowed) {
      this.ledger.toolSettled(request.toolUseId);
      return { behavior: "deny", message: admission.message };
    }
    let allowed = false;
    try {
      const decision = await this.onPermission(request);
      allowed = decision.behavior === "allow";
      return decision;
    } finally {
      this.ledger.permissionSettled();
      if (!allowed) this.ledger.toolSettled(request.toolUseId);
    }
  }

  private wakeArrivals(): void {
    for (const wake of this.arrivals.splice(0)) wake();
  }

  /** Resolves on the next unconsumed input, or once the stream is closed. */
  private async awaitInput(): Promise<void> {
    while (this.acceptedInputs <= this.consumedInputs && !this.closed) {
      await new Promise<void>((resolve) => this.arrivals.push(resolve));
    }
    this.consumedInputs += 1;
  }

  /**
   * What the interrupt ended goes with it, before anyone sees the terminal:
   * the turn's tools stop, and the inputs the terminal names are dropped
   * rather than run by the next turn. Inputs sent after it are kept.
   */
  private interruptedFrame(
    cursor: string,
    index: number,
    reached: boolean,
  ): AgentFrame {
    const reason = this.abortedAt(index, reached);
    for (const step of this.steps.slice(index)) {
      if (step.type === "await-input") break;
      if (step.type === "tool-end") this.ledger.toolSettled(step.toolUseId);
    }
    this.consumedInputs = this.acceptedInputs;
    const message = interruptedMessage(
      this.ledger.pendingUuids(),
      reason,
      this.sessionId,
    );
    this.ledger.observe(message);
    return frameFromNativeMessage(message, this.correlationId, cursor);
  }

  /**
   * The SDK tells an interrupt that caught a tool, or its permission prompt,
   * from one that caught the model mid-response. `reached` says whether the
   * step at `index` had begun.
   */
  private abortedAt(index: number, reached: boolean): TerminalReason {
    const ended = new Set<string>();
    for (let at = reached ? index : index - 1; at >= 0; at -= 1) {
      const step = this.steps[at];
      if (step === undefined || step.type === "await-input") break;
      if (step.type === "permissions" && at === index) return "aborted_tools";
      if (step.type === "tool-end") ended.add(step.toolUseId);
      if (step.type === "tool-start" && !ended.has(step.toolUseId)) {
        return "aborted_tools";
      }
    }
    return "aborted_streaming";
  }
}

// Typed against the SDK: a value no real run sends would let a host that
// branches on it pass here and fail against the engine.
type TerminalReason = NonNullable<InterruptedResult["terminal_reason"]>;

// An interrupt drops every queued input, so the terminal frame attributes all
// of them the way the SDK attributes a batch: last uuid plus the full list.
function interruptedMessage(
  pending: string[],
  reason: TerminalReason,
  sessionId: string,
): NativeSdkMessage {
  const last = pending.at(-1);
  const message: InterruptedResult = {
    type: "result",
    subtype: "error_during_execution",
    session_id: sessionId,
    is_error: true,
    terminal_reason: reason,
    ...(last === undefined
      ? {}
      : { user_message_uuid: last, user_message_uuids: pending }),
  };
  return message;
}

async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  let rejectAbort: ((reason: DOMException) => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function abortError(): DOMException {
  return new DOMException("Run aborted", "AbortError");
}

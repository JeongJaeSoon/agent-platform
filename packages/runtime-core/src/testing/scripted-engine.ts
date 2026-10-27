import type { ParkReadiness } from "../agent-run.ts";
import type { AgentInput, AgentRuntime } from "../agent-runtime.ts";
import type {
  CheckpointLeaseGrant,
  CheckpointPreparation,
} from "../checkpoint.ts";

export type ScriptedPermission = {
  input: Record<string, unknown>;
  requestId: string;
  tool: string;
  toolUseId: string;
};

/** What the engine's own permission gate answered a scripted request. */
export type ScriptedDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export type ScriptedAdmission =
  | { allowed: true }
  | { allowed: false; message: string };

/** A message in some engine's own shape, as a script writes it: plain data. */
export type EngineMessage = { [key: string]: unknown; type: string };

/**
 * One step of a scripted engine. `emit` carries a message in the engine's own
 * shape: the dialect that runs the script is the only reader of it.
 */
export type ScriptedStep =
  /** Hold until one more input has been sent, the way a real engine waits. */
  | { type: "await-input" }
  | { delayMs: number; type: "delay" }
  | { message: unknown; type: "emit" }
  | { error: Error; type: "error" }
  | { requests: ScriptedPermission[]; type: "permissions" }
  /** A tool asking the engine's pre-tool gate to start. */
  | { toolUseId: string; type: "tool-start" }
  /** The tool that started has settled. */
  | { toolUseId: string; type: "tool-end" };

export type ScriptedRuntimeOptions = {
  /**
   * Input uuids already in the transcript a resumed run continues. A send of
   * one is answered with nothing — no frame, no result — and an interrupt
   * afterwards has nothing to end, so it produces no terminal either.
   */
  resumedTranscript?: string[];
  /** Makes a resumed run's `ready()` reject with this, as an unreadable transcript would. */
  resumeFailure?: string;
};

/** A scripted engine behind the runtime contract, with what it saw recorded. */
export interface ScriptedRuntime extends AgentRuntime {
  /** Every input the host sent, including ones the engine deduplicated. */
  readonly inputs: AgentInput[];
  readonly permissionDecisions: ScriptedDecision[];
  /** What the tool gate answered each tool-start step, in order. */
  readonly toolAdmissions: Array<{
    admission: ScriptedAdmission;
    toolUseId: string;
  }>;
}

/** The engine's bookkeeping of inputs, tools and checkpoint readiness. */
export interface ScriptLedger {
  claimConsumer(): void;
  leaseCheckpoint(): CheckpointLeaseGrant;
  observe(message: unknown): void;
  parkable(): ParkReadiness;
  pendingUuids(): string[];
  permissionSettled(toolUseId: string): void;
  permissionStarting(toolUseId: string): ScriptedAdmission;
  prepareCheckpoint(): CheckpointPreparation;
  queued(uuid: string): void;
  streamEnded(): void;
  toolSettled(toolUseId: string): void;
  toolStarting(toolUseId: string): ScriptedAdmission;
  wasSent(uuid: string): boolean;
}

/** Whether an interrupt caught a tool (or its permission prompt) or the model mid-response. */
export type InterruptCut = "tools" | "streaming";

/** What an engine adapter supplies for the scripted engine to speak its messages. */
export interface ScriptDialect<TFrame> {
  /** The session id the engine names its messages with before any says otherwise. */
  readonly initialSessionId: string;
  ledger(resume: string | undefined): ScriptLedger;
  frame(
    message: unknown,
    correlationId: string,
    cursor: string,
    inputs: readonly string[] | undefined,
  ): TFrame;
  sessionIdOf(message: unknown): string | undefined;
  /** The message announcing the calls a permissions step asks about. */
  toolCallMessage(requests: readonly ScriptedPermission[]): unknown;
  /** The terminal an interrupt ends the turn with, naming every input it dropped. */
  interruptedMessage(
    pending: readonly string[],
    cut: InterruptCut,
    sessionId: string,
  ): unknown;
}

export type ScriptedRunStart = {
  correlationId: string;
  mode: "new" | "resume";
  resume?: string | undefined;
};

/** One scripted execution, at the level an engine driver runs it. */
export interface ScriptedDriverRun<TFrame> extends AsyncIterable<TFrame> {
  abort(): void;
  close(): void;
  events(): AsyncIterable<TFrame>;
  finishInput(): void;
  holdsInput(uuid: string): Promise<boolean>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  leaseCheckpoint(): Promise<CheckpointLeaseGrant>;
  parkable(): ParkReadiness;
  prepareCheckpoint(): Promise<CheckpointPreparation>;
  ready(): Promise<void>;
  send(input: AgentInput): void;
}

/** Runs one script against any engine's dialect, recording what the host did. */
export class ScriptedEngine<TFrame> {
  readonly inputs: AgentInput[] = [];
  readonly permissionDecisions: ScriptedDecision[] = [];
  readonly toolAdmissions: Array<{
    admission: ScriptedAdmission;
    toolUseId: string;
  }> = [];

  constructor(
    private readonly steps: ScriptedStep[],
    private readonly dialect: ScriptDialect<TFrame>,
    private readonly options: ScriptedRuntimeOptions = {},
  ) {}

  start(
    start: ScriptedRunStart,
    onPermission: (
      request: ScriptedPermission & { signal: AbortSignal },
    ) => Promise<ScriptedDecision>,
  ): ScriptedDriverRun<TFrame> {
    return new ScriptedRun(
      this,
      this.dialect,
      start.correlationId,
      this.steps,
      onPermission,
      start.resume,
      start.mode === "resume"
        ? new Set(this.options.resumedTranscript ?? [])
        : new Set(),
      start.mode === "resume" ? this.options.resumeFailure : undefined,
    );
  }
}

class ScriptedRun<TFrame> implements ScriptedDriverRun<TFrame> {
  private readonly abortController = new AbortController();
  private readonly arrivals: Array<() => void> = [];
  // Replaced after each interrupt: the run outlives it, like a real engine's.
  private interruptController = new AbortController();
  private readonly ledger: ScriptLedger;
  private closed = false;
  private consumedInputs = 0;
  /** Inputs the engine took, in send order; a deduplicated send is not one. */
  private readonly accepted: string[] = [];
  private get acceptedInputs(): number {
    return this.accepted.length;
  }
  /** Sends the engine ignored because the session already held them. */
  private readonly deduplicated = new Set<string>();
  // First accepted terminal action wins: an interrupt that already returned
  // its receipt still yields its terminal result even if abort() follows.
  private terminal: "aborted" | "interrupted" | undefined;
  /** What the engine names its results with: the session it resumed or reported. */
  private sessionId: string;

  constructor(
    private readonly engine: ScriptedEngine<TFrame>,
    private readonly dialect: ScriptDialect<TFrame>,
    private readonly correlationId: string,
    private readonly steps: ScriptedStep[],
    private readonly onPermission: (
      request: ScriptedPermission & { signal: AbortSignal },
    ) => Promise<ScriptedDecision>,
    resume: string | undefined,
    private readonly resumed: ReadonlySet<string>,
    private readonly resumeFailure: string | undefined,
  ) {
    this.ledger = dialect.ledger(resume);
    this.sessionId = resume ?? dialect.initialSessionId;
  }

  async ready(): Promise<void> {
    if (this.resumeFailure !== undefined) throw new Error(this.resumeFailure);
  }

  send(input: AgentInput): void {
    if (this.closed) throw new Error("Input stream is closed");
    const duplicate =
      this.resumed.has(input.uuid) || this.ledger.wasSent(input.uuid);
    this.ledger.queued(input.uuid);
    this.engine.inputs.push(input);
    if (duplicate) {
      this.deduplicated.add(input.uuid);
      return;
    }
    this.accepted.push(input.uuid);
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

  parkable(): ParkReadiness {
    return this.ledger.parkable();
  }

  events(): AsyncIterable<TFrame> {
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TFrame> {
    this.ledger.claimConsumer();
    try {
      let cursor = 0;
      for (let index = 0; index < this.steps.length; index += 1) {
        const step = this.steps[index] as ScriptedStep;
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
            // A real engine streams the message carrying a call before it
            // asks whether the call may run.
            if (step.type === "permissions") {
              const calls = this.dialect.toolCallMessage(step.requests);
              // Observed like every message a real run streams.
              this.ledger.observe(calls);
              yield this.frame(calls, `fake:${cursor}:calls`);
            }
            // A stop that landed while the calls frame was being consumed
            // ends the turn before anyone is asked.
            if (this.terminal === undefined) {
              await this.runStep(step, controlSignal);
            }
            if (step.type === "emit") {
              this.ledger.observe(step.message);
              const sessionId = this.dialect.sessionIdOf(step.message);
              if (sessionId !== undefined) this.sessionId = sessionId;
              yield this.frame(step.message, `fake:${cursor}`);
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
        // A real engine ends only the current turn: the script resumes at the
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

  private async runStep(
    step: ScriptedStep,
    signal: AbortSignal,
  ): Promise<void> {
    if (step.type === "await-input") {
      await raceAbort(this.awaitInput(), signal);
    } else if (step.type === "delay") {
      await raceAbort(Bun.sleep(step.delayMs), signal);
    } else if (step.type === "error") {
      throw step.error;
    } else if (step.type === "permissions") {
      // Recorded as each settles: an interrupt the decision itself asks for
      // aborts the step before the rest would be.
      await raceAbort(
        Promise.all(
          step.requests.map(async (request) => {
            const decision = await this.askPermission({ ...request, signal });
            this.engine.permissionDecisions.push(decision);
          }),
        ),
        signal,
      );
    } else if (step.type === "tool-start") {
      this.engine.toolAdmissions.push({
        toolUseId: step.toolUseId,
        admission: this.ledger.toolStarting(step.toolUseId),
      });
    } else if (step.type === "tool-end") {
      this.ledger.toolSettled(step.toolUseId);
    }
  }

  /** The same gate a real engine's permission callback goes through. */
  private async askPermission(
    request: ScriptedPermission & { signal: AbortSignal },
  ): Promise<ScriptedDecision> {
    const admission = this.ledger.permissionStarting(request.toolUseId);
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
      this.ledger.permissionSettled(request.toolUseId);
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
  ): TFrame {
    const cut = this.cutAt(index, reached);
    for (const step of this.steps.slice(index)) {
      if (step.type === "await-input") break;
      if (step.type === "tool-end") this.ledger.toolSettled(step.toolUseId);
    }
    this.consumedInputs = this.acceptedInputs;
    const message = this.dialect.interruptedMessage(
      this.ledger.pendingUuids(),
      cut,
      this.sessionId,
    );
    this.ledger.observe(message);
    return this.frame(message, cursor);
  }

  /**
   * Scripted messages mostly name no input, so each frame says which one the
   * script is on: the input the last `await-input` took, or the first one
   * sent before any did.
   */
  private frame(message: unknown, cursor: string): TFrame {
    const current = this.accepted[Math.max(this.consumedInputs - 1, 0)];
    return this.dialect.frame(
      message,
      this.correlationId,
      cursor,
      current === undefined ? undefined : [current],
    );
  }

  /**
   * Whether the interrupt caught a tool, or its permission prompt, or the
   * model mid-response. `reached` says whether the step at `index` had begun.
   */
  private cutAt(index: number, reached: boolean): InterruptCut {
    const ended = new Set<string>();
    for (let at = reached ? index : index - 1; at >= 0; at -= 1) {
      const step = this.steps[at];
      if (step === undefined || step.type === "await-input") break;
      if (step.type === "permissions" && at === index) return "tools";
      if (step.type === "tool-end") ended.add(step.toolUseId);
      if (step.type === "tool-start" && !ended.has(step.toolUseId)) {
        return "tools";
      }
    }
    return "streaming";
  }
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

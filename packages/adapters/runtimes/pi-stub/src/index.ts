import type { SessionEvent } from "@werft-ai/contracts";
import {
  type AgentInput,
  type AgentRun,
  type AgentRuntime,
  type AnswerResult,
  type ApprovalAnswer,
  ApprovalChannel,
  type CheckpointLeaseGrant,
  type CheckpointPreparation,
  type NegotiatedCapabilities,
  negotiatedFromDescriptor,
  type RejectedCheckpoint,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_EVENT_SCHEMA,
  type RuntimeDescriptor,
  type RuntimeEvent,
  type RuntimeEventBody,
  type RuntimeStart,
} from "@werft-ai/runtime-core";

/**
 * Shaped after pi's RPC mode as the design note reads it: approval through
 * an extension `confirm`, no resumable session, no classifier, no MCP until
 * an extension bridges one. Every row here is inferred, not measured.
 */
export const PI_STUB_DESCRIPTOR: RuntimeDescriptor = {
  capabilities: {
    checkpoint: false,
    interrupt: true,
    mcp: "none",
    permissionModes: {
      acceptEdits: "emulated",
      bypassPermissions: "emulated",
      default: "emulated",
    },
    resume: false,
    skills: "none",
  },
  contractVersion: RUNTIME_CONTRACT_VERSION,
  extraFeatures: {},
  kind: "pi_coding_agent",
  optionsNamespace: "pi",
  process: "subprocess",
  runtimeVersion: "stub",
  toolEnv: "tool_only",
};

export type PiStubOptions = Record<string, never>;

/**
 * Answers each input with an echo. An input reading `run <command>` first
 * asks to run it, the way pi's tool_call handler confirms one.
 */
export class PiStubRuntime implements AgentRuntime<PiStubOptions> {
  readonly descriptor = PI_STUB_DESCRIPTOR;
  readonly starts: RuntimeStart<PiStubOptions>[] = [];

  start(start: RuntimeStart<PiStubOptions>): AgentRun {
    if (start.config.mode === "resume") {
      throw new Error("pi keeps no session to resume");
    }
    if (start.bundle.mcpServers.length > 0) {
      throw new Error("pi has no MCP bridge");
    }
    this.starts.push(start);
    return new PiStubRun(start.config.correlationId);
  }
}

const NO_SESSION: RejectedCheckpoint = {
  detail: "pi keeps no session a checkpoint could resume",
  reason: "no_engine_session",
  status: "rejected",
};

class PiStubRun implements AgentRun {
  private readonly approvals = new ApprovalChannel();
  private readonly inputs: AgentInput[] = [];
  private readonly sent = new Set<string>();
  private readonly queued: RuntimeEventBody[] = [];
  private readonly waiters: Array<() => void> = [];
  private finished = false;
  private stop = new AbortController();
  private sequence = 0;
  private calls = 0;

  constructor(private readonly correlationId: string) {}

  abort(): void {
    this.finished = true;
    this.stop.abort();
    this.poke();
  }

  async answer(answer: ApprovalAnswer): Promise<AnswerResult> {
    return this.approvals.answer(answer);
  }

  close(): void {
    this.abort();
  }

  events(): AsyncIterable<RuntimeEvent> {
    return this;
  }

  finishInput(): void {
    this.finished = true;
    this.poke();
  }

  async holdsInput(uuid: string): Promise<boolean> {
    return this.sent.has(uuid);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    this.stop.abort();
    this.stop = new AbortController();
    return { stillQueued: [] };
  }

  async leaseCheckpoint(): Promise<CheckpointLeaseGrant> {
    return { lease: null, preparation: NO_SESSION };
  }

  async prepareCheckpoint(): Promise<CheckpointPreparation> {
    return NO_SESSION;
  }

  async ready(): Promise<NegotiatedCapabilities> {
    return negotiatedFromDescriptor(PI_STUB_DESCRIPTOR);
  }

  send(input: AgentInput): void {
    if (this.finished) throw new Error("Input stream is closed");
    this.sent.add(input.uuid);
    this.inputs.push(input);
    this.poke();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    const turns = this.turns();
    let next: Promise<IteratorResult<void>> | undefined;
    for (;;) {
      for (const body of this.approvals.drain()) yield this.stamp(body);
      for (const body of this.queued.splice(0)) yield this.stamp(body);
      next ??= turns.next();
      const step = await Promise.race([
        next,
        this.approvals.changed().then(() => undefined),
        this.poked(),
      ]);
      if (step === undefined) continue;
      next = undefined;
      if (step.done === true) break;
    }
    for (const body of this.approvals.drain()) yield this.stamp(body);
    for (const body of this.queued.splice(0)) yield this.stamp(body);
  }

  /** Runs one input at a time, queueing what each turn says. */
  private async *turns(): AsyncGenerator<void> {
    for (;;) {
      const input = this.inputs.shift();
      if (input === undefined) {
        if (this.finished) return;
        await this.poked();
        continue;
      }
      await this.turn(input);
      yield;
    }
  }

  private async turn(input: AgentInput): Promise<void> {
    const signal = this.stop.signal;
    const command = /^run (.+)$/.exec(input.message)?.[1];
    let text = `echo: ${input.message}`;
    if (command !== undefined) {
      const toolCallId = `pi_call_${this.calls++}`;
      this.publish(toolUse(toolCallId, command));
      const answer = await this.approvals.request(
        {
          kind: "permission",
          nativeRef: { id: toolCallId, method: "extension_ui_request" },
          tool: { input: { command }, name: "bash" },
          toolCallId,
        },
        signal,
      );
      const allowed =
        answer.outcome === "selected" && answer.optionKind === "allow_once";
      text = allowed ? `ran: ${command}` : `blocked: ${command}`;
    }
    if (!signal.aborted) this.publish(assistant(text));
    this.queued.push({
      type: "turn.ended",
      abortedByStop: signal.aborted,
      // The worker's terminal vocabulary is the Claude result's.
      detail: {
        apiErrorStatus: undefined,
        isError: signal.aborted,
        stopReason: null,
        subtype: signal.aborted ? "error_during_execution" : "success",
        terminalReason: signal.aborted ? "aborted_streaming" : "completed",
      },
      engineSessionId: "pi-stub",
      inputs: [input.uuid],
      usage: null,
    });
    this.poke();
  }

  private publish(event: SessionEvent): void {
    this.queued.push({ type: "v1.projected", events: [event] });
    this.poke();
  }

  private poke(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  private poked(): Promise<undefined> {
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(undefined));
    });
  }

  private stamp(body: RuntimeEventBody): RuntimeEvent {
    const sequence = this.sequence++;
    return {
      ...body,
      correlationId: this.correlationId,
      id: `${this.correlationId}:${sequence}`,
      schema: RUNTIME_EVENT_SCHEMA,
      sequence,
    };
  }
}

// The public v1 event is the Anthropic message shape; pi has to borrow it.
function assistant(text: string): SessionEvent {
  return {
    id: `pi:${crypto.randomUUID()}`,
    event: "assistant",
    data: {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    },
  };
}

function toolUse(id: string, command: string): SessionEvent {
  return {
    id: `pi:${id}`,
    event: "tool_use",
    data: {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id, name: "bash", input: { command } }],
      },
      parent_tool_use_id: null,
    },
  };
}

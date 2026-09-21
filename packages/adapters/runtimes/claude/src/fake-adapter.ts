import type {
  AgentFrame,
  AgentInput,
  AgentRun,
  AgentRuntime,
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
import { TurnLedger } from "./turn-ledger.ts";

export type FakeStep =
  | { delayMs: number; type: "delay" }
  | { message: NativeSdkMessage; type: "emit" }
  | { error: Error; type: "error" }
  | { requests: Omit<PermissionRequest, "signal">[]; type: "permissions" };

export class FakeAgentRuntime implements AgentRuntime<ClaudeRuntimeConfig> {
  readonly capabilities: RuntimeCapabilities = CLAUDE_RUNTIME_CAPABILITIES;
  readonly inputs: AgentInput[] = [];
  readonly permissionDecisions: PermissionDecision[] = [];

  constructor(private readonly steps: FakeStep[]) {}

  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): AgentRun {
    return new FakeRun(
      this,
      config.correlationId,
      this.steps,
      hooks.onPermission,
      config.resume,
    );
  }
}

class FakeRun implements AgentRun {
  private readonly abortController = new AbortController();
  private readonly interruptController = new AbortController();
  private readonly ledger: TurnLedger;
  private closed = false;
  private interrupted = false;

  constructor(
    private readonly runtime: FakeAgentRuntime,
    private readonly correlationId: string,
    private readonly steps: FakeStep[],
    private readonly onPermission: (
      request: PermissionRequest,
    ) => Promise<PermissionDecision>,
    resume?: string,
  ) {
    this.ledger = new TurnLedger(resume);
  }

  send(input: AgentInput): void {
    if (this.closed) throw new Error("Input stream is closed");
    this.ledger.queued(input.uuid);
    this.runtime.inputs.push(input);
  }

  finishInput(): void {
    this.closed = true;
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    this.interrupted = true;
    this.interruptController.abort();
    return { stillQueued: [] };
  }

  abort(): void {
    this.abortController.abort();
  }

  close(): void {
    this.closed = true;
    this.abortController.abort();
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
      const controlSignal = AbortSignal.any([
        this.abortController.signal,
        this.interruptController.signal,
      ]);
      for (const step of this.steps) {
        if (this.abortController.signal.aborted) throw abortError();
        if (this.interrupted) {
          yield this.interruptedFrame(`fake:${cursor}`);
          return;
        }
        try {
          if (step.type === "delay") {
            await raceAbort(Bun.sleep(step.delayMs), controlSignal);
          } else if (step.type === "error") {
            throw step.error;
          } else if (step.type === "permissions") {
            const decisions = await raceAbort(
              Promise.all(
                step.requests.map((request) =>
                  this.onPermission({
                    ...request,
                    signal: controlSignal,
                  }),
                ),
              ),
              controlSignal,
            );
            this.runtime.permissionDecisions.push(...decisions);
          } else {
            this.ledger.observe(step.message);
            yield frameFromNativeMessage(
              step.message,
              this.correlationId,
              `fake:${cursor}`,
            );
          }
        } catch (error) {
          if (this.abortController.signal.aborted) throw error;
          if (this.interrupted) {
            yield this.interruptedFrame(`fake:${cursor}:interrupted`);
            return;
          }
          throw error;
        }
        if (this.abortController.signal.aborted) throw abortError();
        if (this.interrupted) {
          yield this.interruptedFrame(`fake:${cursor}:interrupted`);
          return;
        }
        cursor += 1;
      }
    } finally {
      this.ledger.streamEnded();
    }
  }

  private interruptedFrame(cursor: string): AgentFrame {
    const message = interruptedMessage(this.ledger.pendingUuids());
    this.ledger.observe(message);
    return frameFromNativeMessage(message, this.correlationId, cursor);
  }
}

// An interrupt drops every queued input, so the terminal frame attributes all
// of them the way the SDK attributes a batch: last uuid plus the full list.
function interruptedMessage(pending: string[]): NativeSdkMessage {
  const last = pending.at(-1);
  return {
    type: "result",
    subtype: "error_during_execution",
    session_id: "fake-session",
    is_error: true,
    terminal_reason: "interrupted",
    ...(last === undefined
      ? {}
      : { user_message_uuid: last, user_message_uuids: pending }),
  };
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

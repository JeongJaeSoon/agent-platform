import { frameFromNativeMessage } from "./mapper.ts";
import type {
  AgentFrame,
  AgentInput,
  AgentRun,
  AgentRuntime,
  NativeSdkMessage,
  PermissionDecision,
  PermissionRequest,
  RuntimeConfig,
} from "./runtime.ts";

export type FakeStep =
  | { delayMs: number; type: "delay" }
  | { message: NativeSdkMessage; type: "emit" }
  | { error: Error; type: "error" }
  | { requests: Omit<PermissionRequest, "signal">[]; type: "permissions" };

export class FakeAgentRuntime implements AgentRuntime {
  readonly inputs: AgentInput[] = [];
  readonly permissionDecisions: PermissionDecision[] = [];

  constructor(private readonly steps: FakeStep[]) {}

  start(
    config: RuntimeConfig,
    onPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): AgentRun {
    return new FakeRun(this, config.correlationId, this.steps, onPermission);
  }
}

class FakeRun implements AgentRun {
  private readonly abortController = new AbortController();
  private readonly interruptController = new AbortController();
  private closed = false;
  private interrupted = false;

  constructor(
    private readonly runtime: FakeAgentRuntime,
    private readonly correlationId: string,
    private readonly steps: FakeStep[],
    private readonly onPermission: (
      request: PermissionRequest,
    ) => Promise<PermissionDecision>,
  ) {}

  send(input: AgentInput): void {
    if (this.closed) throw new Error("Input stream is closed");
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

  async *[Symbol.asyncIterator](): AsyncIterator<AgentFrame> {
    let cursor = 0;
    const controlSignal = AbortSignal.any([
      this.abortController.signal,
      this.interruptController.signal,
    ]);
    for (const step of this.steps) {
      if (this.abortController.signal.aborted) throw abortError();
      if (this.interrupted) {
        yield interruptedFrame(this.correlationId, `fake:${cursor}`);
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
          yield frameFromNativeMessage(
            step.message,
            this.correlationId,
            `fake:${cursor}`,
          );
        }
      } catch (error) {
        if (this.abortController.signal.aborted) throw error;
        if (this.interrupted) {
          yield interruptedFrame(
            this.correlationId,
            `fake:${cursor}:interrupted`,
          );
          return;
        }
        throw error;
      }
      if (this.abortController.signal.aborted) throw abortError();
      if (this.interrupted) {
        yield interruptedFrame(
          this.correlationId,
          `fake:${cursor}:interrupted`,
        );
        return;
      }
      cursor += 1;
    }
  }
}

function interruptedFrame(correlationId: string, cursor: string): AgentFrame {
  return frameFromNativeMessage(
    {
      type: "result",
      subtype: "error_during_execution",
      session_id: "fake-session",
      is_error: true,
      terminal_reason: "interrupted",
    },
    correlationId,
    cursor,
  );
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

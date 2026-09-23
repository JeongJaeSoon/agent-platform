import type {
  AgentFrame,
  AgentInput,
  AgentRun,
  CheckpointLeaseGrant,
  CheckpointPreparation,
  NativeSdkMessage,
} from "@agent-platform/runtime-core";
import type {
  Query,
  SDKMessage,
  SDKResultError,
  SDKUserMessage,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";

import { frameFromNativeMessage } from "./mapper.ts";
import type { ResumedHistory } from "./resumed-history.ts";
import type { TurnLedger } from "./turn-ledger.ts";

/**
 * How the SDK ends a turn cut short mid-response or with a tool (or its
 * permission prompt) outstanding. `interrupt()` ends a turn this way, but so
 * does any other abort, so a reason from this set proves an interrupt only to
 * a host that knows it sent one.
 */
export const ABORTED_TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set([
  "aborted_streaming",
  "aborted_tools",
]);

export function endedByAbort(message: NativeSdkMessage): boolean {
  return (
    message.type === "result" &&
    ABORTED_TERMINAL_REASONS.has(message.terminal_reason as TerminalReason)
  );
}

/** The fields of the result an interrupted turn ends with. */
export type InterruptedResult = Pick<
  SDKResultError,
  | "is_error"
  | "session_id"
  | "subtype"
  | "terminal_reason"
  | "type"
  | "user_message_uuid"
  | "user_message_uuids"
>;

export class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly waiting: Array<
    (value: IteratorResult<SDKUserMessage>) => void
  > = [];
  private finished = false;

  push(input: AgentInput): void {
    if (this.finished) throw new Error("Input stream is closed");
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: input.message },
      parent_tool_use_id: null,
      uuid: input.uuid as NonNullable<SDKUserMessage["uuid"]>,
    };
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(message);
    else waiter({ done: false, value: message });
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiting.splice(0))
      waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.queued.shift();
        if (value !== undefined) return { done: false, value };
        if (this.finished) return { done: true, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

export class ClaudeSdkRun implements AgentRun {
  constructor(
    private readonly correlationId: string,
    private readonly input: InputStream,
    private readonly sdkQuery: Query,
    private readonly abortController: AbortController,
    private readonly history: ResumedHistory,
    /** Shared with the SDK options' tool gate, which feeds and consults it. */
    private readonly ledger: TurnLedger,
  ) {}

  send(input: AgentInput): void {
    this.ledger.queued(input.uuid);
    try {
      this.input.push(input);
    } catch (error) {
      this.ledger.release(input.uuid);
      throw error;
    }
  }

  finishInput(): void {
    this.input.finish();
  }

  async holdsInput(uuid: string): Promise<boolean> {
    if (this.ledger.wasSent(uuid)) return true;
    return (await this.history.uuids()).has(uuid);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const receipt = await this.sdkQuery.interrupt();
    return { stillQueued: receipt?.still_queued ?? [] };
  }

  abort(): void {
    this.abortController.abort();
  }

  close(): void {
    this.input.finish();
    this.sdkQuery.close();
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
      for await (const message of this.sdkQuery) {
        const native = message as SDKMessage as unknown as NativeSdkMessage;
        this.ledger.observe(native);
        yield frameFromNativeMessage(
          native,
          this.correlationId,
          `sdk:${cursor}`,
        );
        cursor += 1;
      }
    } finally {
      this.ledger.streamEnded();
      this.history.abandon();
    }
  }
}

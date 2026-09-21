import type {
  AgentFrame,
  AgentInput,
  AgentRun,
  CheckpointPreparation,
  NativeSdkMessage,
} from "@agent-platform/runtime-core";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { frameFromNativeMessage } from "./mapper.ts";
import { TurnLedger } from "./turn-ledger.ts";

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
  private readonly ledger: TurnLedger;

  constructor(
    private readonly correlationId: string,
    private readonly input: InputStream,
    private readonly sdkQuery: Query,
    private readonly abortController: AbortController,
    resume?: string,
  ) {
    this.ledger = new TurnLedger(resume);
  }

  send(input: AgentInput): void {
    this.input.push(input);
    this.ledger.queued(input.uuid);
  }

  finishInput(): void {
    this.input.finish();
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

  async prepareCheckpoint(): Promise<CheckpointPreparation> {
    return this.ledger.prepareCheckpoint();
  }

  events(): AsyncIterable<AgentFrame> {
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentFrame> {
    this.ledger.claimConsumer();
    let cursor = 0;
    for await (const message of this.sdkQuery) {
      const native = message as SDKMessage as unknown as NativeSdkMessage;
      this.ledger.observe(native);
      yield frameFromNativeMessage(native, this.correlationId, `sdk:${cursor}`);
      cursor += 1;
    }
    this.ledger.streamEnded();
  }
}

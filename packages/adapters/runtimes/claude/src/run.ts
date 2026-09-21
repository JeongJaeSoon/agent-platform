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

import { CLAUDE_AGENT_SDK_VERSION } from "./config.ts";
import { frameFromNativeMessage } from "./mapper.ts";

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
  private sessionId: string | undefined;
  // True from send() until the turn's `result` frame; a checkpoint taken in
  // that window would miss the transcript the SDK has not flushed.
  private streaming = false;

  constructor(
    private readonly correlationId: string,
    private readonly input: InputStream,
    private readonly sdkQuery: Query,
    private readonly abortController: AbortController,
    resume?: string,
  ) {
    this.sessionId = resume;
  }

  send(input: AgentInput): void {
    this.input.push(input);
    this.streaming = true;
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
    if (this.streaming) {
      return { status: "rejected", reason: "A turn is still running" };
    }
    if (this.sessionId === undefined) {
      return { status: "rejected", reason: "No SDK session has started" };
    }
    return {
      status: "ready",
      checkpoint: {
        engine: "claude",
        resume: this.sessionId,
        sdkVersion: CLAUDE_AGENT_SDK_VERSION,
      },
    };
  }

  events(): AsyncIterable<AgentFrame> {
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentFrame> {
    let cursor = 0;
    for await (const message of this.sdkQuery) {
      const native = message as SDKMessage as unknown as NativeSdkMessage;
      this.observe(native);
      yield frameFromNativeMessage(native, this.correlationId, `sdk:${cursor}`);
      cursor += 1;
    }
    this.streaming = false;
  }

  private observe(message: NativeSdkMessage): void {
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    this.streaming = message.type !== "result";
  }
}

import type {
  CheckpointPreparation,
  NativeSdkMessage,
} from "@agent-platform/runtime-core";

import { CLAUDE_AGENT_SDK_VERSION } from "./config.ts";

/**
 * Shared bookkeeping for ClaudeSdkRun and FakeRun: which SDK session a
 * checkpoint would resume, how many sent inputs have not produced a `result`
 * yet, and whether frames are mid-turn. A checkpoint taken while anything is
 * outstanding would point at a transcript the SDK has not flushed.
 */
export class TurnLedger {
  private consumed = false;
  private pendingInputs = 0;
  private sessionId: string | undefined;
  private streaming = false;

  constructor(resume?: string) {
    this.sessionId = resume;
  }

  queued(): void {
    this.pendingInputs += 1;
  }

  observe(message: NativeSdkMessage): void {
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    if (message.type === "result") {
      this.streaming = false;
      this.pendingInputs = Math.max(0, this.pendingInputs - 1);
    } else {
      this.streaming = true;
    }
  }

  streamEnded(): void {
    this.streaming = false;
  }

  claimConsumer(): void {
    if (this.consumed) {
      throw new Error("AgentRun events can only be consumed once");
    }
    this.consumed = true;
  }

  prepareCheckpoint(): CheckpointPreparation {
    if (this.streaming || this.pendingInputs > 0) {
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
}

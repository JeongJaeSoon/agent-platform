import type {
  CheckpointPreparation,
  NativeSdkMessage,
} from "@agent-platform/runtime-core";

import { CLAUDE_AGENT_SDK_VERSION } from "./config.ts";

/**
 * Shared bookkeeping for ClaudeSdkRun and FakeRun: which SDK session a
 * checkpoint would resume, which sent input uuids no `result` has consumed
 * yet, and whether frames are mid-turn. A checkpoint taken while anything is
 * outstanding would point at a transcript the SDK has not flushed.
 *
 * The SDK may fold several queued sends into one turn, so a result settles
 * every uuid it lists in `user_message_uuids` (or `user_message_uuid`), not
 * just one input. A result from an older producer that names no uuid settles
 * everything queued so far. Informational frames after a result do not reopen
 * the turn unless input is still pending.
 */
export class TurnLedger {
  private consumed = false;
  private readonly pending = new Set<string>();
  private sessionId: string | undefined;
  private streaming = false;

  constructor(resume?: string) {
    this.sessionId = resume;
  }

  queued(uuid: string): void {
    this.pending.add(uuid);
  }

  observe(message: NativeSdkMessage): void {
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    if (message.type !== "result") {
      this.streaming = this.pending.size > 0;
      return;
    }
    this.streaming = false;
    const consumed = consumedUuids(message);
    if (consumed === undefined) this.pending.clear();
    else for (const uuid of consumed) this.pending.delete(uuid);
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
    if (this.streaming || this.pending.size > 0) {
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

function consumedUuids(message: NativeSdkMessage): string[] | undefined {
  if (Array.isArray(message.user_message_uuids)) {
    return message.user_message_uuids.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (typeof message.user_message_uuid === "string") {
    return [message.user_message_uuid];
  }
  return undefined;
}

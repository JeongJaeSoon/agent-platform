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
 * The SDK may fold several queued sends into one turn. A result names the
 * batch's last input in `user_message_uuid` and up to 64 members in
 * `user_message_uuids`, so the ledger keeps send order and settles every
 * pending input queued up to and including that last uuid, plus any listed
 * one. A result that attributes no uuid (delivery failures, zeroed or
 * session-scoped errors) settles nothing: the ledger fails closed rather than
 * guess which input the transcript now holds. Informational frames after a
 * result do not reopen the turn unless input is still pending.
 *
 * A `system/mirror_error` frame latches for the run. The SDK emits it once it
 * has given up on a transcript batch, and then keeps going — the turn can still
 * come back successful. The mirrored transcript is missing entries nobody can
 * name, so nothing this run captures is safely resumable, and it refuses to
 * prepare a checkpoint until a fresh run re-mirrors from the local file.
 */
export class TurnLedger {
  private consumed = false;
  private mirrorError: string | undefined;
  private readonly pending = new Set<string>();
  private sessionId: string | undefined;
  private streaming = false;

  constructor(resume?: string) {
    this.sessionId = resume;
  }

  queued(uuid: string): void {
    if (this.pending.has(uuid)) {
      throw new Error(`Input uuid is already queued: ${uuid}`);
    }
    this.pending.add(uuid);
  }

  /** Inputs no result has settled yet, in send order. */
  pendingUuids(): string[] {
    return [...this.pending];
  }

  /** Undo queued() when the input never reached the engine. */
  release(uuid: string): void {
    this.pending.delete(uuid);
  }

  observe(message: NativeSdkMessage): void {
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "mirror_error") {
      this.mirrorError ??= mirrorErrorDetail(message);
    }
    if (message.type !== "result") {
      this.streaming = this.pending.size > 0;
      return;
    }
    this.streaming = false;
    const last = message.user_message_uuid;
    if (typeof last === "string" && this.pending.has(last)) {
      for (const uuid of [...this.pending]) {
        this.pending.delete(uuid);
        if (uuid === last) break;
      }
    }
    for (const uuid of consumedUuids(message)) this.pending.delete(uuid);
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
    if (this.mirrorError !== undefined) {
      return {
        status: "rejected",
        reason: "mirror_error",
        detail: this.mirrorError,
      };
    }
    if (this.streaming || this.pending.size > 0) {
      return {
        status: "rejected",
        reason: "turn_in_flight",
        detail: "A turn is still running",
      };
    }
    if (this.sessionId === undefined) {
      return {
        status: "rejected",
        reason: "no_engine_session",
        detail: "No SDK session has started",
      };
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

function mirrorErrorDetail(message: NativeSdkMessage): string {
  const error =
    typeof message.error === "string" && message.error.length > 0
      ? message.error
      : "unspecified error";
  const key = message.key as { subpath?: unknown } | undefined;
  const target =
    typeof key?.subpath === "string" ? `subagent ${key.subpath}` : "root";
  return `Transcript mirror dropped a ${target} batch: ${error}`;
}

function consumedUuids(message: NativeSdkMessage): string[] {
  if (Array.isArray(message.user_message_uuids)) {
    return message.user_message_uuids.filter(
      (value): value is string => typeof value === "string",
    );
  }
  if (typeof message.user_message_uuid === "string") {
    return [message.user_message_uuid];
  }
  return [];
}

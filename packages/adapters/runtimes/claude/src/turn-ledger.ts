import type {
  CheckpointLeaseGrant,
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
 *
 * A turn boundary is not quiescence. A tool the engine let
 * through the PreToolUse gate is in flight until a hook or its tool_result
 * settles it, a permission callback is a tool about to run, and a background
 * task (a backgrounded Bash, a subagent) keeps writing after the turn's result.
 * The ledger refuses a checkpoint while any of them is outstanding, and a
 * checkpoint lease, once taken, refuses every new tool and input until it is
 * released.
 *
 * What this proves is the engine's own view: tools it runs and tasks it
 * tracks. A process a command detached from the engine, a server a project
 * hook started, or a sibling hook command that runs beside a refused tool is
 * invisible here and can still write.
 */
export class TurnLedger {
  private backgroundTasks: string[] = [];
  private consumed = false;
  private lease: object | undefined;
  private mirrorError: string | undefined;
  private readonly pending = new Set<string>();
  private permissionCallbacks = 0;
  /** Every uuid that reached the engine on this run, settled or not. */
  private readonly sent = new Set<string>();
  private sessionId: string | undefined;
  private streaming = false;
  private readonly toolsInFlight = new Set<string>();

  constructor(resume?: string) {
    this.sessionId = resume;
  }

  queued(uuid: string): void {
    if (this.lease !== undefined) {
      throw new Error(`A checkpoint is being captured; input ${uuid} waits`);
    }
    if (this.pending.has(uuid)) {
      throw new Error(`Input uuid is already queued: ${uuid}`);
    }
    this.pending.add(uuid);
    this.sent.add(uuid);
  }

  /** Sent on this run: the engine would deduplicate it rather than run it. */
  wasSent(uuid: string): boolean {
    return this.sent.has(uuid);
  }

  /** Inputs no result has settled yet, in send order. */
  pendingUuids(): string[] {
    return [...this.pending];
  }

  /** Undo queued() when the input never reached the engine. */
  release(uuid: string): void {
    this.pending.delete(uuid);
    this.sent.delete(uuid);
  }

  observe(message: NativeSdkMessage): void {
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    if (message.type === "system" && message.subtype === "mirror_error") {
      this.mirrorError ??= mirrorErrorDetail(message);
    }
    if (
      message.type === "system" &&
      message.subtype === "background_tasks_changed"
    ) {
      this.backgroundTasks = liveTaskIds(message);
    }
    if (message.type === "user") {
      for (const id of toolResultIds(message)) this.toolsInFlight.delete(id);
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

  /**
   * Tools and tasks stay outstanding: the end of the stream does not prove
   * the engine or anything it started has exited, so a run that lost its
   * stream mid-tool stays unfit to checkpoint.
   */
  streamEnded(): void {
    this.streaming = false;
  }

  /**
   * PreToolUse: the engine waits on this answer before it runs the tool, in
   * the main thread and in every subagent alike, so a lease taken between two
   * calls here holds against all of them.
   */
  toolStarting(toolUseId: string): ToolAdmission {
    if (this.lease !== undefined) return leasedAdmission;
    this.toolsInFlight.add(toolUseId);
    return { allowed: true };
  }

  /** PostToolUse, PostToolUseFailure, PermissionDenied, or a permission denial. */
  toolSettled(toolUseId: string): void {
    this.toolsInFlight.delete(toolUseId);
  }

  /** A permission callback opened; pair an admitted one with permissionSettled(). */
  permissionStarting(): ToolAdmission {
    if (this.lease !== undefined) return leasedAdmission;
    this.permissionCallbacks += 1;
    return { allowed: true };
  }

  permissionSettled(): void {
    this.permissionCallbacks = Math.max(0, this.permissionCallbacks - 1);
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
    if (this.lease !== undefined) {
      return {
        status: "rejected",
        reason: "checkpoint_lease_held",
        detail: "Another checkpoint holds the lease",
      };
    }
    const tools = this.toolsInFlight.size + this.permissionCallbacks;
    if (tools > 0) {
      return {
        status: "rejected",
        reason: "tool_in_flight",
        detail: `${tools} tool call(s) still running`,
      };
    }
    if (this.backgroundTasks.length > 0) {
      return {
        status: "rejected",
        reason: "background_writer",
        detail: `Background task(s) still running: ${this.backgroundTasks.join(", ")}`,
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

  /**
   * Judges the run and, when it is quiescent, takes the lease in the same
   * synchronous step: no hook answer can land between the two.
   */
  leaseCheckpoint(): CheckpointLeaseGrant {
    const preparation = this.prepareCheckpoint();
    if (preparation.status === "rejected") return { lease: null, preparation };
    const held = {};
    this.lease = held;
    return {
      preparation,
      lease: {
        release: () => {
          if (this.lease === held) this.lease = undefined;
        },
      },
    };
  }
}

export type ToolAdmission =
  | { allowed: true }
  | { allowed: false; message: string };

const leasedAdmission: ToolAdmission = {
  allowed: false,
  message:
    "A checkpoint is being saved; no tool may start until it is committed",
};

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

/** Replace semantics: the level signal names every live task after a change. */
function liveTaskIds(message: NativeSdkMessage): string[] {
  if (!Array.isArray(message.tasks)) return [];
  return message.tasks.flatMap((task: unknown) => {
    const id = (task as { task_id?: unknown } | null)?.task_id;
    return typeof id === "string" ? [id] : [];
  });
}

function toolResultIds(message: NativeSdkMessage): string[] {
  const content = (message.message as { content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    const part = block as { tool_use_id?: unknown; type?: unknown } | null;
    return part?.type === "tool_result" && typeof part.tool_use_id === "string"
      ? [part.tool_use_id]
      : [];
  });
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

import type {
  BootstrapClaimResponse,
  CheckpointRef,
  WorkerScope,
} from "@agent-platform/contracts";
import type {
  CheckpointObjectStore,
  CheckpointPreparation,
  TranscriptMirror,
} from "@agent-platform/runtime-core";

/**
 * How a run is opened: fresh, or continuing the engine session a checkpoint
 * named. `sessionStore` is where the engine mirrors its transcripts; a run
 * without one keeps them only on this container's disk, and nothing it does
 * can be checkpointed.
 */
export type RuntimeResumePlan =
  | { mode: "new"; sessionStore?: TranscriptMirror }
  | {
      mode: "resume";
      resume: string;
      /** Set only by a plan that resumes this container's own disk. */
      localTranscriptResume?: true;
      sessionStore?: TranscriptMirror;
    };

/** What a capture needs from the turn it runs in. */
export type CheckpointCaptureContext = {
  /** The fenced identity the checkpoint request is made under. */
  scope: WorkerScope;
  /**
   * The run's verdict now, for a publisher that has to know whether
   * something changed while it uploaded — a `mirror_error` that arrived
   * after the lease was taken makes the capture worthless.
   */
  recheck(): Promise<CheckpointPreparation>;
};

/**
 * The worker's side of checkpointing. Restoring an engine session and
 * building the manifest that finalize commits both live behind this port so
 * the turn loop never grows a storage dependency.
 */
export interface WorkerCheckpointPort {
  /**
   * Turns the claim into the config the runtime starts with: its restore
   * pointer, and the generation and identity the transcripts are kept under.
   * Called once, after the workspace is prepared and before the engine runs.
   */
  restorePlan(claim: BootstrapClaimResponse): Promise<RuntimeResumePlan>;
  /**
   * The ref finalize should commit, or null when this turn produced none.
   * Called with every preparation, rejected ones included: those are
   * reported to the gateway, which records the refusals that outlive a turn.
   * Throws only when the attempt no longer owns the session.
   */
  capture(
    preparation: CheckpointPreparation,
    context: CheckpointCaptureContext,
  ): Promise<CheckpointRef | null>;
  /**
   * When the transcript mirror last took a write, for the heartbeat; absent
   * while no mirror is bound.
   */
  mirror?(): { persistedAt: Date | null } | undefined;
}

/**
 * Checkpoints nothing and restores nothing: a session that *has* a
 * checkpoint refuses to start rather than quietly opening a fresh engine
 * session on top of its workspace. What the composition root binds until the
 * restorer (the second half of 94S-246) lands — publishing without it would
 * turn the first committed checkpoint into a session no replacement worker
 * can start.
 */
export const unwiredCheckpoints: WorkerCheckpointPort = {
  async restorePlan(claim) {
    const restore = claim.restore;
    if (restore === null) return { mode: "new" };
    throw new Error(
      `Session needs checkpoint revision ${restore.revision} restored, and this worker has no restorer bound (94S-246)`,
    );
  },
  async capture() {
    return null;
  },
};

/**
 * The port the composition root hands the host, built on the session-scoped
 * object store. The store is held but not read yet: `SessionCheckpoints`
 * publishes, and it is bound here once it also restores (94S-246).
 */
export function checkpointsOn(
  _objectStore: CheckpointObjectStore,
): WorkerCheckpointPort {
  return unwiredCheckpoints;
}

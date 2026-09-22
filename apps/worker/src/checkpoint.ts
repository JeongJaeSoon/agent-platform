import type { CheckpointRef } from "@agent-platform/contracts";
import type {
  CheckpointPreparation,
  TranscriptMirror,
} from "@agent-platform/runtime-core";

/** How a run is opened: fresh, or continuing the engine session a checkpoint named. */
export type RuntimeResumePlan =
  | { mode: "new" }
  | {
      mode: "resume";
      resume: string;
      /** Set only by a plan that resumes this container's own disk. */
      localTranscriptResume?: true;
      sessionStore?: TranscriptMirror;
    };

/**
 * The worker's side of checkpointing. Restoring an engine session and
 * building the manifest that finalize commits both live behind this port so
 * the turn loop never grows a storage dependency.
 */
export interface WorkerCheckpointPort {
  /** Turns the claim's restore pointer into the config the runtime starts with. */
  restorePlan(restore: CheckpointRef | null): Promise<RuntimeResumePlan>;
  /** The ref finalize should commit, or null when this turn produced none. */
  capture(preparation: CheckpointPreparation): Promise<CheckpointRef | null>;
}

/**
 * Deliberately minimal: CheckpointService is not bound to the gateway yet
 * (94S-201) and a finalize carrying a checkpoint is refused today, so this
 * commits nothing. Left out: writing the manifest and restoring from one.
 * Replace it with the real coordinator once 94S-201 binds the verifier —
 * until then a session that *has* a checkpoint refuses to start rather than
 * quietly opening a fresh engine session on top of its workspace.
 */
export const unwiredCheckpoints: WorkerCheckpointPort = {
  async restorePlan(restore) {
    if (restore === null) return { mode: "new" };
    throw new Error(
      `Session needs checkpoint revision ${restore.revision} restored, and this worker has no checkpoint service bound (94S-201)`,
    );
  },
  async capture() {
    return null;
  },
};

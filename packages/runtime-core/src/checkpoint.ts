export type RuntimeCheckpoint = {
  engine: string;
  /** Handle a later `mode: "resume"` config passes back to the same engine. */
  resume: string;
  sdkVersion: string;
};

/**
 * Why a run refuses to be checkpointed right now. The host stores the code as
 * the session's pending reason, so it has to be stable and machine-readable;
 * `detail` carries the human wording.
 */
export type CheckpointBlockReason =
  | "mirror_error"
  | "no_engine_session"
  | "turn_in_flight";

export type CheckpointPreparation =
  | { checkpoint: RuntimeCheckpoint; status: "ready" }
  | { detail: string; reason: CheckpointBlockReason; status: "rejected" };

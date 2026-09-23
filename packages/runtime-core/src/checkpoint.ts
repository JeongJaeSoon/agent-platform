export type RuntimeCheckpoint = {
  engine: string;
  /** Handle a later `mode: "resume"` config passes back to the same engine. */
  resume: string;
  sdkVersion: string;
};

/**
 * Why a run refuses to be checkpointed right now. The host stores the code as
 * the session's pending reason, so it has to be stable and machine-readable;
 * `detail` carries the human wording. `publish_failed` is never a run's
 * verdict: the publisher reports it when a ready run's checkpoint could not be
 * written.
 */
export type CheckpointBlockReason =
  | "background_writer"
  | "checkpoint_lease_held"
  | "mirror_error"
  | "no_engine_session"
  | "publish_failed"
  | "tool_in_flight"
  | "turn_in_flight";

export type ReadyCheckpoint = {
  checkpoint: RuntimeCheckpoint;
  status: "ready";
};
export type RejectedCheckpoint = {
  detail: string;
  reason: CheckpointBlockReason;
  status: "rejected";
};
export type CheckpointPreparation = ReadyCheckpoint | RejectedCheckpoint;

/**
 * The run's promise that nothing writes to the workspace or the transcript
 * while a checkpoint is captured and committed (DESIGN §6.3.1). While it is
 * held every new tool call and input is refused. It is local to the run and
 * has nothing to do with the execution lease the gateway fences on: that one
 * says who owns the session, this one says nobody is writing.
 *
 * It does not expire. A publisher that gives up waiting has not stopped its
 * request, and a pointer CAS that lands after writers were let back in would
 * commit a capture the workspace no longer matches. So it is released only
 * once whatever might still commit has answered — a publisher that never
 * answers keeps the agent from using tools until the run ends.
 */
export interface CheckpointLease {
  /** Idempotent. */
  release(): void;
}

export type CheckpointLeaseGrant =
  | { lease: CheckpointLease; preparation: ReadyCheckpoint }
  | { lease: null; preparation: RejectedCheckpoint };

export type RuntimeCheckpoint = {
  engine: string;
  /** Handle a later `mode: "resume"` config passes back to the same engine. */
  resume: string;
  sdkVersion: string;
};

export type CheckpointPreparation =
  | { checkpoint: RuntimeCheckpoint; status: "ready" }
  | { reason: string; status: "rejected" };

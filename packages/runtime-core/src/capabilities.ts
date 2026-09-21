export type RuntimeCapabilities = {
  /** The engine can pause an in-flight turn and report what stayed queued. */
  interrupt: boolean;
  /** prepareCheckpoint can yield a handle a later `mode: "resume"` accepts. */
  checkpoint: boolean;
  /** start() honours `mode: "resume"`. */
  resume: boolean;
};

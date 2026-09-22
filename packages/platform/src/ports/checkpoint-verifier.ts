import type { CheckpointRef } from "@agent-platform/contracts";
import type { WorkerFence } from "./worker-unit-of-work.ts";

export type CheckpointVerdict =
  | { status: "verified" }
  | { status: "rejected"; reason: string };

// finalize refuses to promote a checkpoint pointer the verifier has not
// accepted. The whole fence is passed, not just the session: reading the
// manifest proves it exists, not that *this* attempt wrote it, and promoting
// another attempt's orphan manifest is exactly what the epoch is for. 94S-201
// wires the storage-backed implementation and decides how its pointer CAS and
// this turn's commit coordinate.
export interface CheckpointVerifier {
  verify(input: {
    fence: WorkerFence;
    turnId: string;
    checkpoint: CheckpointRef;
    // The gateway's clock at the call, so a verifier that judges freshness
    // uses the same one the fence is judged against.
    at: Date;
  }): Promise<CheckpointVerdict>;
}

// Test-only: accepts any structurally valid ref. A deployment that wires
// this promotes checkpoint pointers nobody has read, and the damage only
// surfaces at the next restore, when the execution that wrote them is gone.
export const acceptAllCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "verified" };
  },
};

// The default a composition root gets until 94S-201 binds the storage-backed
// verifier that 94S-124 built: finalize without a checkpoint still commits,
// and a checkpoint is refused rather than trusted.
export const rejectUnverifiedCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "rejected", reason: "no checkpoint verifier configured" };
  },
};

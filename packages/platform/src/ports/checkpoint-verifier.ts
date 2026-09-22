import type { CheckpointRef } from "@agent-platform/contracts";

export type CheckpointVerdict =
  | { status: "verified" }
  | { status: "rejected"; reason: string };

// finalize refuses to promote a checkpoint pointer the verifier has not
// accepted; the D2 checkpoint ticket (94S-124) supplies the storage-backed
// implementation that reads the manifest and compares its hash.
export interface CheckpointVerifier {
  verify(input: {
    sessionId: string;
    checkpoint: CheckpointRef;
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

// The default a composition root gets until 94S-124 supplies the
// storage-backed verifier: finalize without a checkpoint still commits, and
// a checkpoint is refused rather than trusted.
export const rejectUnverifiedCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "rejected", reason: "no checkpoint verifier configured" };
  },
};

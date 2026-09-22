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

// Accepts any structurally valid ref; for tests and until 94S-124 lands.
export const acceptAllCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "verified" };
  },
};

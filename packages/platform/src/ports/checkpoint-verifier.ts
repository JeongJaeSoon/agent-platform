import type { CheckpointRef } from "@agent-platform/contracts";
import type { ManifestVerdict } from "../checkpoints/checkpoint-service.ts";
import type { CheckpointFence } from "./checkpoint-store.ts";
import type { WorkerFence } from "./worker-unit-of-work.ts";

export type CheckpointVerdict =
  | { status: "verified" }
  | { status: "rejected"; reason: string };

// finalize refuses to promote a checkpoint pointer the verifier has not
// accepted. The whole fence is passed, not just the session: reading the
// manifest proves it exists, not that *this* attempt wrote it, and promoting
// another attempt's orphan manifest is exactly what the epoch is for.
// `serviceCheckpointVerifier` is the storage-backed one; the pointer itself
// is advanced by the turn's own transaction (finalizeAtomic), never here.
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

// What a composition root gets when no object store is configured: finalize
// without a checkpoint still commits, and a checkpoint is refused rather than
// trusted.
export const rejectUnverifiedCheckpoints: CheckpointVerifier = {
  async verify() {
    return { status: "rejected", reason: "no checkpoint verifier configured" };
  },
};

/**
 * The storage-backed verifier: the manifest must be this attempt's own key
 * and must validate down to the workspace bundle. `at` is not consulted —
 * freshness is the fence's business, and the gateway re-judges the lease at
 * commit time.
 */
export function serviceCheckpointVerifier(service: {
  verifyAttemptManifest(input: {
    checkpoint: CheckpointRef;
    fence: CheckpointFence;
  }): Promise<ManifestVerdict>;
}): CheckpointVerifier {
  return {
    async verify({ fence, checkpoint }) {
      const verdict = await service.verifyAttemptManifest({
        checkpoint,
        fence: {
          attemptId: fence.attemptId,
          authRevision: fence.authRevision,
          executionGeneration: fence.executionGeneration,
          leaseEpoch: fence.leaseEpoch,
          sessionId: fence.sessionId,
        },
      });
      return verdict.status === "verified"
        ? { status: "verified" }
        : { status: "rejected", reason: verdict.reason };
    },
  };
}

import { describe, expect, test } from "bun:test";
import type { CheckpointManifest } from "@agent-platform/runtime-core";
import { serviceCheckpointVerifier } from "./checkpoint-verifier.ts";

const fence = {
  sessionId: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
  attemptId: "att_1",
  leaseEpoch: 2,
  executionGeneration: 3,
  authRevision: 4,
};
const checkpoint = {
  revision: 1,
  manifest_ref: "sessions/s/checkpoints/0000000001/att_1/manifest.json",
  manifest_sha256: "0".repeat(64),
};

describe("serviceCheckpointVerifier", () => {
  test("hands the service the whole fence and reduces its verdict to the port's", async () => {
    const asked: unknown[] = [];
    let verdict:
      | { status: "verified"; manifest: CheckpointManifest }
      | { status: "rejected"; reason: string } = {
      status: "rejected",
      reason: "manifest digest mismatch",
    };
    const verifier = serviceCheckpointVerifier({
      async verifyAttemptManifest(input) {
        asked.push(input);
        return verdict;
      },
    });
    const at = new Date("2026-09-23T00:00:00Z");
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({ status: "rejected", reason: "manifest digest mismatch" });
    // The fence is what proves the manifest is this attempt's: session and
    // attempt pick the key, the epochs ride along for the pointer CAS.
    expect(asked).toEqual([{ checkpoint, fence }]);

    verdict = { status: "verified", manifest: {} as CheckpointManifest };
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({ status: "verified" });
  });
});

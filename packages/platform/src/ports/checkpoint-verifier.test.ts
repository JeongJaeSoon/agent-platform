import { describe, expect, test } from "bun:test";
import type { CheckpointManifest } from "@werft-ai/runtime-core";
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
      | {
          limit?: "transcript_too_large";
          status: "rejected";
          reason: string;
        } = {
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

    verdict = {
      status: "rejected",
      reason: "the transcript is over the limit",
      limit: "transcript_too_large",
    };
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({
      status: "rejected",
      reason: "the transcript is over the limit",
      limit: "transcript_too_large",
    });

    const part = (key: string, bytes: number) => ({
      bytes,
      key,
      sha256: "0".repeat(64),
    });
    verdict = {
      status: "verified",
      manifest: {
        transcripts: {
          root: { parts: [part("a", 10), part("b", 5)] },
          subagents: { "agent-1": { parts: [part("c", 7)] } },
        },
      } as unknown as CheckpointManifest,
    };
    // The total the session detail judges TRANSCRIPT_LIMIT on.
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({ status: "verified", outputs: [], transcriptBytes: 22 });

    // Outputs: two paths of the same content are one object, an inherited
    // ref is named like any other, and an omitted file has no object at all.
    verdict = {
      status: "verified",
      manifest: {
        transcripts: { root: { parts: [] }, subagents: {} },
        outputs: [
          { ...part("s/checkpoints/1/att_1/outputs/aa", 100), path: "out/a" },
          { ...part("s/checkpoints/1/att_1/outputs/aa", 100), path: "out/b" },
          { ...part("s/checkpoints/0/att_0/outputs/cc", 30), path: "out/c" },
          { bytes: 5_000_000_000, omitted: "too_large", path: "out/big" },
        ],
      } as unknown as CheckpointManifest,
    };
    expect(
      await verifier.verify({ fence, turnId: "1", checkpoint, at }),
    ).toEqual({
      status: "verified",
      outputs: [
        { key: "s/checkpoints/1/att_1/outputs/aa", bytes: 100 },
        { key: "s/checkpoints/0/att_0/outputs/cc", bytes: 30 },
      ],
      transcriptBytes: 0,
    });
  });
});

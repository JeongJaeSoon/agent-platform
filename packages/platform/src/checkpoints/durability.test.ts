import { describe, expect, test } from "bun:test";
import { MAX_TRANSCRIPT_BYTES } from "@agent-platform/runtime-core";

import {
  checkpointPendingReason,
  checkpointReasonBlocks,
  checkpointReasonHoldsWork,
  nextPendingReason,
  projectDurability,
  storedPendingReasonBlocks,
  storedPendingReasonHoldsWork,
  transcriptLimitAttention,
  transcriptWarnBytes,
} from "./durability.ts";

describe("checkpoint pending reason", () => {
  test("a run that can be checkpointed has nothing pending", () => {
    expect(
      checkpointPendingReason({
        status: "ready",
        checkpoint: { engine: "claude", resume: "s1", sdkVersion: "0.3.270" },
      }),
    ).toBeNull();
  });

  test("a turn in flight is not a durability problem", () => {
    expect(
      checkpointPendingReason({
        status: "rejected",
        reason: "turn_in_flight",
        detail: "A turn is still running",
      }),
    ).toBeNull();
  });

  test("a run that never started an engine session is not one either", () => {
    expect(
      checkpointPendingReason({
        status: "rejected",
        reason: "no_engine_session",
        detail: "No SDK session has started",
      }),
    ).toBeNull();
  });

  test("a dropped mirror batch is", () => {
    expect(
      checkpointPendingReason({
        status: "rejected",
        reason: "mirror_error",
        detail: "Transcript mirror dropped a root batch: append rejected",
      }),
    ).toBe("mirror_error");
  });
});

describe("a run that was not quiescent", () => {
  const refusals = [
    ["tool_in_flight", "1 tool call(s) still running"],
    ["background_writer", "Background task(s) still running: bash_1"],
    ["checkpoint_lease_held", "Another checkpoint holds the lease"],
    ["publish_failed", "workspace: 12000 untracked files, over the 10000"],
  ] as const;

  test.each(refusals)("surfaces %s as the pending reason", (reason, detail) => {
    expect(
      checkpointPendingReason({ status: "rejected", reason, detail }),
    ).toBe(reason);
    expect(
      projectDurability({
        checkpointCommittedAt: null,
        checkpointFallbackRevision: null,
        checkpointRevision: 3,
        contextResetTurnId: null,
        lastCheckpointedTurnId: "3",
        lastCompletedTurnId: "4",
        lastTranscriptPersistedAt: null,
        pendingReason: reason,
      }).checkpoint_pending_reason,
    ).toBe(reason);
  });

  test.each(refusals)("%s holds no work back", (reason) => {
    expect(checkpointReasonHoldsWork(reason)).toBe(false);
    expect(storedPendingReasonHoldsWork(reason)).toBe(false);
  });

  test("never replaces a mirror failure, which a later one replaces", () => {
    expect(nextPendingReason("mirror_error", "background_writer")).toBe(
      "mirror_error",
    );
    expect(nextPendingReason("background_writer", "tool_in_flight")).toBe(
      "tool_in_flight",
    );
    expect(nextPendingReason("tool_in_flight", "mirror_error")).toBe(
      "mirror_error",
    );
    expect(nextPendingReason(null, "checkpoint_lease_held")).toBe(
      "checkpoint_lease_held",
    );
    expect(nextPendingReason("mirror_error", "publish_failed")).toBe(
      "mirror_error",
    );
  });
});

describe("a transcript past its limits", () => {
  const reasons = [
    ["transcript_too_large"],
    ["transcript_part_too_large"],
  ] as const;

  test.each(reasons)("%s is recorded and refuses new turns", (reason) => {
    expect(
      checkpointPendingReason({ status: "rejected", reason, detail: "over" }),
    ).toBe(reason);
    expect(checkpointReasonHoldsWork(reason)).toBe(true);
    expect(storedPendingReasonHoldsWork(reason)).toBe(true);
  });

  test.each(reasons)(
    "%s still trusts the last checkpoint and lets the turn that crossed it complete",
    (reason) => {
      expect(checkpointReasonBlocks(reason)).toBe(false);
      expect(storedPendingReasonBlocks(reason)).toBe(false);
    },
  );

  test("a mirror failure and an unknown reason distrust the pointer", () => {
    expect(checkpointReasonBlocks("mirror_error")).toBe(true);
    expect(storedPendingReasonBlocks("mirror_error")).toBe(true);
    expect(storedPendingReasonBlocks("from_a_newer_build")).toBe(true);
    expect(storedPendingReasonBlocks("publish_failed")).toBe(false);
  });

  test("outranks an advisory reason and yields to a mirror failure", () => {
    expect(nextPendingReason("transcript_too_large", "publish_failed")).toBe(
      "transcript_too_large",
    );
    expect(nextPendingReason("publish_failed", "transcript_too_large")).toBe(
      "transcript_too_large",
    );
    expect(nextPendingReason("transcript_too_large", "mirror_error")).toBe(
      "mirror_error",
    );
    expect(nextPendingReason("mirror_error", "transcript_too_large")).toBe(
      "mirror_error",
    );
    expect(
      nextPendingReason("transcript_part_too_large", "transcript_too_large"),
    ).toBe("transcript_too_large");
  });
});

describe("transcript limit warning", () => {
  const limits = { partBytes: 40, totalBytes: 100 };
  const MiB = 1024 * 1024;

  test("warns from 80% of the total", () => {
    expect(transcriptWarnBytes(limits)).toBe(80);
  });

  test("the warning follows the checkpoint limit", () => {
    expect(transcriptWarnBytes()).toBe(Math.floor(MAX_TRANSCRIPT_BYTES * 0.8));
    // 409.6 MiB under a 512 MiB limit
    expect(
      transcriptWarnBytes({ partBytes: 16 * MiB, totalBytes: 512 * MiB }),
    ).toBe(429_496_729);
  });

  test("the session detail names the reason and the limit it is judged by", () => {
    expect(transcriptLimitAttention(null, null, limits)).toBeNull();
    expect(transcriptLimitAttention(null, 79, limits)).toBeNull();
    expect(transcriptLimitAttention("publish_failed", 80, limits)).toEqual({
      code: "TRANSCRIPT_LIMIT",
      reason: "transcript_near_limit",
      transcript_bytes: 80,
      limit_bytes: 100,
    });
    expect(
      transcriptLimitAttention("transcript_too_large", 90, limits),
    ).toEqual({
      code: "TRANSCRIPT_LIMIT",
      reason: "transcript_too_large",
      transcript_bytes: 90,
      limit_bytes: 100,
    });
    expect(
      transcriptLimitAttention("transcript_part_too_large", null, limits),
    ).toEqual({
      code: "TRANSCRIPT_LIMIT",
      reason: "transcript_part_too_large",
      transcript_bytes: null,
      limit_bytes: 40,
    });
  });
});

describe("durability projection", () => {
  test("reports the committed checkpoint and the turns around it", () => {
    expect(
      projectDurability({
        checkpointCommittedAt: new Date("2026-09-22T00:00:01.000Z"),
        checkpointFallbackRevision: null,
        checkpointRevision: 4,
        contextResetTurnId: null,
        lastCheckpointedTurnId: "7",
        lastCompletedTurnId: "9",
        lastTranscriptPersistedAt: new Date("2026-09-22T00:00:02.000Z"),
        pendingReason: "mirror_error",
      }),
    ).toEqual({
      checkpoint_committed_at: "2026-09-22T00:00:01.000Z",
      checkpoint_fallback_revision: null,
      checkpoint_pending_reason: "mirror_error",
      checkpoint_revision: 4,
      context_reset_turn_id: null,
      last_checkpointed_turn_id: "7",
      last_completed_turn_id: "9",
      last_transcript_persisted_at: "2026-09-22T00:00:02.000Z",
    });
  });

  test("a session that has never checkpointed reports nulls, not zeroes", () => {
    expect(
      projectDurability({
        checkpointCommittedAt: null,
        checkpointFallbackRevision: null,
        checkpointRevision: null,
        contextResetTurnId: null,
        lastCheckpointedTurnId: null,
        lastCompletedTurnId: null,
        lastTranscriptPersistedAt: null,
        pendingReason: null,
      }),
    ).toEqual({
      checkpoint_committed_at: null,
      checkpoint_fallback_revision: null,
      checkpoint_pending_reason: null,
      checkpoint_revision: null,
      context_reset_turn_id: null,
      last_checkpointed_turn_id: null,
      last_completed_turn_id: null,
      last_transcript_persisted_at: null,
    });
  });

  test("a session restored from an earlier revision says which one", () => {
    expect(
      projectDurability({
        checkpointCommittedAt: null,
        checkpointFallbackRevision: 2,
        checkpointRevision: 4,
        contextResetTurnId: null,
        lastCheckpointedTurnId: "9",
        lastCompletedTurnId: "9",
        lastTranscriptPersistedAt: null,
        pendingReason: null,
      }),
    ).toMatchObject({
      checkpoint_fallback_revision: 2,
      checkpoint_revision: 4,
    });
  });

  test("a completed turn ahead of the checkpointed one is visible as such", () => {
    const durability = projectDurability({
      checkpointCommittedAt: new Date("2026-09-22T00:00:01.000Z"),
      checkpointFallbackRevision: null,
      checkpointRevision: 1,
      contextResetTurnId: null,
      lastCheckpointedTurnId: "3",
      lastCompletedTurnId: "5",
      lastTranscriptPersistedAt: null,
      pendingReason: null,
    });

    expect(durability.last_completed_turn_id).not.toBe(
      durability.last_checkpointed_turn_id,
    );
  });
});

describe("a pending reason as the session row stores it", () => {
  test("nothing stored holds nothing back, a mirror failure does", () => {
    expect(storedPendingReasonHoldsWork(null)).toBe(false);
    expect(storedPendingReasonHoldsWork("mirror_error")).toBe(true);
  });

  test("a value this build does not know is treated as blocking", () => {
    expect(storedPendingReasonHoldsWork("disk_on_fire")).toBe(true);
    expect(storedPendingReasonHoldsWork("")).toBe(true);
  });
});

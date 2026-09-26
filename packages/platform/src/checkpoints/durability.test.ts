import { describe, expect, test } from "bun:test";

import {
  checkpointPendingReason,
  checkpointReasonHoldsWork,
  nextPendingReason,
  projectDurability,
  storedPendingReasonHoldsWork,
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

  test("a session restored from an earlier revision says which one (94S-204)", () => {
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

import { describe, expect, test } from "bun:test";
import type { SchedulerRunSummary } from "@agent-platform/platform";
import { exitCodeFor } from "./main.ts";

const clean: SchedulerRunSummary = {
  activeAfter: 0,
  activeBefore: 0,
  failedLaunches: [],
  launched: [],
  orphansTerminated: [],
  orphansUnresolved: [],
  reclaimFailed: [],
  reconcileFailed: [],
  reensured: [],
  replaced: [],
  replacementsExhausted: [],
  skipped: false,
  slotLimit: 10,
  terminatedObserved: [],
  workspaceScanFailed: false,
  workspacesFailed: [],
  workspacesReclaimed: [],
  workspacesUnresolved: [],
};
const ref = { executionId: "exec-1", generation: 1 };

describe("scheduler exit code", () => {
  test("a clean or skipped pass exits 0", () => {
    expect(exitCodeFor(clean)).toBe(0);
    expect(exitCodeFor({ ...clean, skipped: true })).toBe(0);
  });

  test("unfinished work exits 1 so supervisors notice", () => {
    expect(exitCodeFor({ ...clean, failedLaunches: [ref] })).toBe(1);
    expect(exitCodeFor({ ...clean, orphansUnresolved: [ref] })).toBe(1);
    expect(exitCodeFor({ ...clean, reclaimFailed: [ref] })).toBe(1);
    expect(exitCodeFor({ ...clean, reconcileFailed: [ref] })).toBe(1);
    expect(exitCodeFor({ ...clean, replacementsExhausted: [ref] })).toBe(1);
  });

  test("a GC fault exits 1, a GC judgement does not", () => {
    expect(exitCodeFor({ ...clean, workspaceScanFailed: true })).toBe(1);
    expect(exitCodeFor({ ...clean, workspacesFailed: ["ap-ws-1"] })).toBe(1);
    // Still mounted, or someone else's: both deliberate, both retried next
    // pass, neither a reason to wake anyone.
    expect(exitCodeFor({ ...clean, workspacesUnresolved: ["ap-ws-1"] })).toBe(
      0,
    );
  });
});

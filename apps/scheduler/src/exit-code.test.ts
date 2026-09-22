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
  skipped: false,
  slotLimit: 10,
  terminatedObserved: [],
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
  });
});

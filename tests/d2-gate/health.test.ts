import { describe, expect, test } from "bun:test";
import { judgeHealth } from "../../apps/control-host/src/pass-loop/health.ts";
import type { PassStatus } from "../../apps/control-host/src/pass-loop/loop.ts";
import { UNHEALTHY } from "./harness.ts";

const now = new Date("2026-09-24T12:00:00Z");
const base: PassStatus = {
  loopStartedAt: "2026-09-24T11:00:00Z",
  passes: 3,
  lastSuccessAt: "2026-09-24T11:59:00Z",
  lastFailureAt: null,
  lastFailureReason: null,
  lastSkippedAt: null,
  lastDegradedAt: null,
  lastPassDurationMs: 10,
  consecutiveFailures: 0,
  passDeadlineAt: null,
};

// H4 of control-host-roles.e2e.test.ts only runs on the D2 stack, so a
// reworded reason would first show up there as a loop that never looks down.
describe("the gate's UNHEALTHY pattern", () => {
  test.each([
    ["no status file", null],
    ["no pass completed", { ...base, lastSuccessAt: null }],
    [
      "failed passes",
      {
        ...base,
        consecutiveFailures: 2,
        lastFailureReason: "connect ECONNREFUSED",
      },
    ],
    ["past the deadline", { ...base, passDeadlineAt: "2026-09-24T11:59:30Z" }],
  ] as const)("matches the reason for %s", (_, status) => {
    const verdict = judgeHealth(status, now, 60_000);
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toMatch(UNHEALTHY);
  });

  test("does not match the reasons of a loop that completes passes", () => {
    for (const status of [
      base,
      { ...base, lastSuccessAt: null, lastDegradedAt: base.lastSuccessAt },
    ]) {
      expect(judgeHealth(status, now, 60_000).reason).not.toMatch(UNHEALTHY);
    }
  });
});

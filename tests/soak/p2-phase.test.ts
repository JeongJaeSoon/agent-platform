import { describe, expect, test } from "bun:test";
import {
  buildPhasePlan,
  judgePhase,
  type PhaseSample,
} from "../../scripts/soak/p2-phase.ts";

const plan = buildPhasePlan(Date.UTC(2026, 8, 27, 0, 0, 0));

function samples(latencies: number[]): PhaseSample[] {
  return plan.map((entry, index) => ({
    sequence: entry.sequence,
    plannedAt: entry.plannedAt,
    plannedBucket: entry.bucket,
    sentAt: new Date(entry.plannedAtMs).toISOString(),
    sentAtMs: entry.plannedAtMs,
    actualBucket: entry.bucket,
    inPlannedWindow: true,
    acceptMs: latencies[index] ?? 1,
    status: 202,
    accepted: true,
    response: {},
    hostProbe: [],
  }));
}

describe("P-2 supplemental phase measurement", () => {
  test("plans exactly two samples in every UTC five-second bucket", () => {
    expect(plan).toHaveLength(120);
    const counts = Array.from({ length: 60 }, () => 0);
    for (const entry of plan) counts[entry.bucket] += 1;
    expect(counts).toEqual(Array.from({ length: 60 }, () => 2));
    expect(plan[0]?.plannedAtMs).toBeGreaterThanOrEqual(
      Date.UTC(2026, 8, 27, 0, 15, 0),
    );
  });

  test("marks a sample outside its planned window invalid", () => {
    const got = samples(Array.from({ length: 120 }, () => 1));
    const late = got[0] as PhaseSample;
    late.sentAtMs += 5_000;
    late.sentAt = new Date(late.sentAtMs).toISOString();
    expect(judgePhase(plan, got)).toMatchObject({
      verdict: "INVALID",
      inPlannedWindow: 119,
    });
  });

  test("uses the 114th sorted sample as the n=120 p95 boundary", () => {
    const atLimit = [
      ...Array.from({ length: 114 }, () => 500),
      ...Array.from({ length: 6 }, () => 501),
    ];
    expect(judgePhase(plan, samples(atLimit))).toMatchObject({
      verdict: "PASS",
      latency: { p95: 500 },
    });

    const overLimit = [
      ...Array.from({ length: 113 }, () => 500),
      ...Array.from({ length: 7 }, () => 501),
    ];
    expect(judgePhase(plan, samples(overLimit))).toMatchObject({
      verdict: "INVALID",
      latency: { p95: 501 },
    });
  });
});

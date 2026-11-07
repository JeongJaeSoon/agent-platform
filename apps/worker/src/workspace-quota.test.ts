import { expect, test } from "bun:test";
import type { WorkspaceMeasurement } from "./workspace-meter.ts";
import { WorkspaceQuota } from "./workspace-quota.ts";

const limits = { bytes: 100, inodes: 10 };
const soft = { bytes: "soft", inodes: "unknown", reason: "test" } as const;
const usage = (
  bytes: number,
  inodes = 1,
  complete = true,
): WorkspaceMeasurement => ({
  bytes,
  inodes,
  complete,
  errors: complete ? 0 : 1,
  durationMs: 1,
});

test("only a growing soft axis strictly above its limit fails", () => {
  const quota = new WorkspaceQuota(limits, usage(90));
  expect(quota.exceeded(usage(100), soft)).toBe(false);
  expect(quota.exceeded(usage(101), soft)).toBe(true);
  expect(quota.exceeded(usage(200), { ...soft, bytes: "hard" })).toBe(false);
  expect(quota.exceeded(usage(200, 11), { ...soft, bytes: "hard" })).toBe(true);
});

test("an over-quota session can reduce or keep its starting usage", () => {
  const quota = new WorkspaceQuota(limits, usage(200, 20));
  expect(quota.exceeded(usage(200, 20), soft)).toBe(false);
  expect(quota.exceeded(usage(150, 15), soft)).toBe(false);
  expect(quota.exceeded(usage(201, 15), soft)).toBe(true);
});

test("partial scans need consecutive confirmation on the same axis", () => {
  const quota = new WorkspaceQuota(limits, usage(50));
  expect(quota.exceeded(usage(101, 1, false), soft)).toBe(false);
  expect(quota.exceeded(usage(50, 11, false), soft)).toBe(false);
  expect(quota.exceeded(usage(101, 1, false), soft)).toBe(false);
  expect(quota.exceeded(usage(102, 1, false), soft)).toBe(true);
});

test("a failed baseline waits for a complete measurement", () => {
  const quota = new WorkspaceQuota(limits, usage(0, 0, false));
  expect(quota.exceeded(usage(200, 1, false), soft)).toBe(false);
  expect(quota.exceeded(usage(200), soft)).toBe(false);
  expect(quota.exceeded(usage(201), soft)).toBe(true);
});

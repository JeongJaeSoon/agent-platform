import { expect, test } from "bun:test";
import type { WorkspaceMeasurement } from "./workspace-meter.ts";
import {
  measurementInterval,
  WorkspaceObserver,
} from "./workspace-observer.ts";

const complete: WorkspaceMeasurement = {
  bytes: 100,
  inodes: 3,
  complete: true,
  errors: 0,
  durationMs: 300,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("interval targets at most ten percent duty with a thirty second floor", () => {
  expect(measurementInterval(300)).toBe(30_000);
  expect(measurementInterval(8000)).toBe(80_000);
});

test("classification waits for the first successful measurement after an exception", async () => {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log = (event: string, fields?: Record<string, unknown>) =>
    logs.push({ event, ...(fields === undefined ? {} : { fields }) });
  let now = 0;
  let calls = 0;
  const observer = new WorkspaceObserver(
    { root: "/workspace", evidence: { localQuota: "enforced" } },
    { info: log, warn: log, error: log },
    async () => {
      if (++calls === 1) throw new Error("measurement unavailable");
      return {
        ...complete,
        mount: { mountPoint: "/workspace", filesystem: "xfs", options: [] },
        filesystem: {
          totalBytes: 1000,
          freeBytes: 900,
          totalInodes: 100,
          freeInodes: 97,
        },
      };
    },
    () => now,
  );
  try {
    observer.start();
    await tick();
    expect(calls).toBe(1);
    expect(
      logs.some((row) => row.event === "workspace_measurement_incomplete"),
    ).toBe(true);
    expect(logs.filter((row) => row.event === "workspace_limit_mode")).toEqual(
      [],
    );
    expect(
      logs.filter((row) => row.fields?.metric === "workspace_limit_mode"),
    ).toEqual([]);

    now = 30_000;
    observer.nudge();
    await tick();
    expect(calls).toBe(2);
    expect(
      logs.find((row) => row.event === "workspace_limit_mode")?.fields,
    ).toMatchObject({ bytes: "hard", inodes: "hard" });

    now = 60_000;
    observer.nudge();
    await tick();
    expect(calls).toBe(3);
    expect(
      logs.filter((row) => row.event === "workspace_limit_mode"),
    ).toHaveLength(1);
    expect(
      logs.filter((row) => row.fields?.metric === "workspace_limit_mode"),
    ).toMatchObject([
      { fields: { axis: "bytes", mode: "hard" } },
      { fields: { axis: "inodes", mode: "hard" } },
    ]);
  } finally {
    observer.stop();
  }
});

test("nudges coalesce, retain complete usage after errors and expose degraded state", async () => {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log = (event: string, fields?: Record<string, unknown>) =>
    logs.push({ event, ...(fields === undefined ? {} : { fields }) });
  let now = 0;
  let calls = 0;
  let finish: ((value: WorkspaceMeasurement) => void) | undefined;
  const observer = new WorkspaceObserver(
    { root: "/workspace" },
    { info: log, warn: log, error: log },
    async () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => now,
  );
  observer.start();
  await tick();
  observer.nudge();
  observer.nudge();
  await tick();
  expect(calls).toBe(1);
  finish?.(complete);
  await tick();
  expect(
    logs.find((row) => row.event === "workspace_limit_mode")?.fields,
  ).toMatchObject({ bytes: "unknown", inodes: "unknown" });
  now = 1000;
  observer.nudge();
  await tick();
  expect(calls).toBe(1);
  now = 700_000;
  observer.nudge();
  await tick();
  expect(calls).toBe(2);
  finish?.({ ...complete, complete: false, bytes: 5, inodes: 1, errors: 1 });
  await tick();
  observer.stop();
  expect(
    logs.filter((row) => row.event === "workspace_measurement").at(-1)?.fields,
  ).toMatchObject({
    bytes: 100,
    inodes: 3,
    partial_bytes: 5,
    partial_inodes: 1,
  });
  expect(
    logs.find((row) => row.event === "workspace_measurement_incomplete")
      ?.fields,
  ).toMatchObject({ value: 1, degraded: true });
});

test("stopping aborts measurement and ignores late callbacks", async () => {
  let resolve: ((measurement: WorkspaceMeasurement) => void) | undefined;
  let signal: AbortSignal | undefined;
  const logs: string[] = [];
  const log = (event: string) => logs.push(event);
  const observer = new WorkspaceObserver(
    { root: "/workspace" },
    { info: log, warn: log, error: log },
    async (_root, _budget, supplied) => {
      signal = supplied;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  observer.start();
  await tick();
  observer.stop();
  expect(signal?.aborted).toBe(true);
  resolve?.(complete);
  await tick();
  expect(logs).toEqual([]);
});

test("staleness becomes visible even while the measurement is stuck", async () => {
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log = (event: string, fields?: Record<string, unknown>) =>
    logs.push({ event, ...(fields === undefined ? {} : { fields }) });
  let finish: ((measurement: WorkspaceMeasurement) => void) | undefined;
  const observer = new WorkspaceObserver(
    { root: "/workspace" },
    { info: log, warn: log, error: log },
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    undefined,
    10,
  );
  observer.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  observer.stop();
  finish?.(complete);
  expect(
    logs.find((entry) => entry.event === "workspace_measurement_degraded")
      ?.fields,
  ).toMatchObject({ metric: "workspace_measure_degraded", value: 1 });
});

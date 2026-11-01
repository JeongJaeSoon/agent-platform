import { describe, expect, test } from "bun:test";

import {
  createCooldown,
  createGate,
  MAX_COOLING_BUNDLES,
} from "./bundle-throttle.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createGate", () => {
  test("rejects a limit that is not a positive integer", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createGate(limit)).toThrow(
        `Concurrency limit must be a positive integer: ${limit}`,
      );
    }
  });

  test("runs concurrent callers one at a time, in arrival order", async () => {
    const run = createGate(1);
    const started: number[] = [];
    const finished: number[] = [];
    const tasks = [deferred(), deferred(), deferred()];
    const results = tasks.map((task, index) =>
      run(async () => {
        started.push(index);
        await task.promise;
        finished.push(index);
        return index;
      }),
    );

    await tick();
    expect(started).toEqual([0]);
    tasks[0]?.resolve();
    await tick();
    expect(started).toEqual([0, 1]);
    tasks[1]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    tasks[2]?.resolve();

    expect(await Promise.all(results)).toEqual([0, 1, 2]);
    expect(finished).toEqual([0, 1, 2]);
  });

  test("hands a finished slot to a waiter before a newcomer gets in", async () => {
    const run = createGate(1);
    let running = 0;
    let peak = 0;
    const first = deferred();
    const track = (wait: Promise<void>) =>
      run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await wait;
        running -= 1;
      });

    const second = deferred();
    const held = track(first.promise);
    const waiter = track(second.promise);
    await tick();
    first.resolve();
    await tick();
    expect(running).toBe(1);
    // The waiter now holds the handed-over slot, so this one has to queue.
    const newcomer = track(Promise.resolve());
    await tick();
    expect(peak).toBe(1);
    second.resolve();
    await Promise.all([held, waiter, newcomer]);

    expect(peak).toBe(1);
  });

  test("frees the slot when a task throws", async () => {
    const run = createGate(1);
    const failing = deferred();
    const failed = run(() => failing.promise);
    const next = run(async () => "next");
    failing.reject(new Error("boom"));

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("next");
  });

  test("lets up to the limit run at once", async () => {
    const run = createGate(2);
    const started: number[] = [];
    const tasks = [deferred(), deferred(), deferred()];
    const results = tasks.map((task, index) =>
      run(async () => {
        started.push(index);
        await task.promise;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);
    tasks[1]?.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    tasks[0]?.resolve();
    tasks[2]?.resolve();
    await Promise.all(results);
  });
});

describe("createCooldown", () => {
  test("rejects a negative or non-finite cooldown", () => {
    for (const ms of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createCooldown(ms, () => 0)).toThrow(
        `Bundle retry cooldown must be at least 0: ${ms}`,
      );
    }
  });

  test("holds the failure until the cooldown has passed, not at its edge", () => {
    let now = 1_000;
    const cooling = createCooldown(500, () => now);
    const cause = new Error("bad pack");

    expect(cooling.pending("a")).toBeUndefined();
    cooling.start("a", "bundle-key", cause);

    now = 1_499;
    const error = cooling.pending("a");
    expect(error?.message).toBe(
      `workspace bundle bundle-key is not verified again before ${new Date(1_500).toISOString()}; its last verification failed: bad pack`,
    );
    expect(error?.cause).toBe(cause);

    now = 1_500;
    expect(cooling.pending("a")).toBeUndefined();
    // The expired entry is gone, so rewinding the clock does not revive it.
    now = 1_000;
    expect(cooling.pending("a")).toBeUndefined();
  });

  test("restarts the window when the same bundle fails again", () => {
    let now = 0;
    const cooling = createCooldown(100, () => now);
    cooling.start("a", "k", "first");
    now = 90;
    cooling.start("a", "k", "second");

    now = 150;
    expect(cooling.pending("a")?.message).toEndWith(
      "its last verification failed: second",
    );
    now = 190;
    expect(cooling.pending("a")).toBeUndefined();
  });

  test("a zero cooldown never holds a bundle", () => {
    const cooling = createCooldown(0, () => 0);
    cooling.start("a", "k", new Error("bad"));
    expect(cooling.pending("a")).toBeUndefined();
  });

  test("forgets the oldest bundle once the table is full", () => {
    const cooling = createCooldown(1_000, () => 0);
    for (let index = 0; index <= MAX_COOLING_BUNDLES; index += 1) {
      cooling.start(`b${index}`, "k", "bad");
    }

    expect(cooling.pending("b0")).toBeUndefined();
    expect(cooling.pending("b1")).toBeInstanceOf(Error);
    expect(cooling.pending(`b${MAX_COOLING_BUNDLES}`)).toBeInstanceOf(Error);
  });
});

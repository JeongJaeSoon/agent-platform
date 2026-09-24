import { describe, expect, test } from "bun:test";
import type { SchedulerStore } from "@agent-platform/platform";
import { isConnectionLoss, latchOnConnectionLoss } from "./connection-latch.ts";

const coded = (code: string) => Object.assign(new Error("boom"), { code });

describe("isConnectionLoss", () => {
  test.each([
    ["pg read timeout", new Error("Query read timeout")],
    [
      "pg connect timeout",
      new Error("Connection terminated due to connection timeout"),
    ],
    [
      "pool checkout timeout",
      new Error("timeout exceeded when trying to connect"),
    ],
    ["08006 connection failure", coded("08006")],
    ["57P01 admin shutdown", coded("57P01")],
    ["ECONNREFUSED", coded("ECONNREFUSED")],
    ["ENOTFOUND: the host stopped resolving", coded("ENOTFOUND")],
    ["ENETDOWN", coded("ENETDOWN")],
    [
      "wrapped by drizzle",
      new Error("Failed query: select 1", {
        cause: new Error("Query read timeout"),
      }),
    ],
  ])("%s is a lost connection", (_name, error) => {
    expect(isConnectionLoss(error)).toBe(true);
  });

  test.each([
    ["57014 statement_timeout", coded("57014")],
    ["23505 unique violation", coded("23505")],
    ["40001 serialization failure", coded("40001")],
    ["a Docker failure", new Error("container name conflict")],
    ["not an error", "Query read timeout"],
    ["nothing", undefined],
  ])("%s is not", (_name, error) => {
    expect(isConnectionLoss(error)).toBe(false);
  });
});

describe("latchOnConnectionLoss", () => {
  function fakeStore(failWith: unknown) {
    const calls: string[] = [];
    let unlocked = 0;
    const store = {
      async acquirePassLock() {
        calls.push("acquirePassLock");
        return {
          signal: new AbortController().signal,
          release: async () => {
            unlocked += 1;
          },
        };
      },
      async desiredStateOf() {
        calls.push("desiredStateOf");
        throw failWith;
      },
      async markOverdueTerminations() {
        calls.push("markOverdueTerminations");
        return 0;
      },
    } as unknown as SchedulerStore;
    return { calls, store, unlocked: () => unlocked };
  }

  test("after a lost connection every later call fails at once, but the unlock still runs", async () => {
    const lost = new Error("Query read timeout");
    const fake = fakeStore(lost);
    const reported: unknown[] = [];
    const latch = latchOnConnectionLoss(fake.store, (error) =>
      reported.push(error),
    );
    const lock = await latch.store.acquirePassLock();
    const ref = { executionId: "e", generation: 1 };

    await expect(latch.store.desiredStateOf(ref)).rejects.toBe(lost);
    expect(latch.lost()).toBe(lost);
    expect(reported).toEqual([lost]);

    await expect(latch.store.desiredStateOf(ref)).rejects.toBe(lost);
    await expect(
      latch.store.markOverdueTerminations({ deadlineMs: 1, now: new Date() }),
    ).rejects.toBe(lost);
    // Neither reached the database.
    expect(fake.calls).toEqual(["acquirePassLock", "desiredStateOf"]);
    expect(reported).toHaveLength(1);

    await lock?.release();
    expect(fake.unlocked()).toBe(1);
  });

  test("a statement-level failure leaves the store open", async () => {
    const cancelled = coded("57014");
    const fake = fakeStore(cancelled);
    const latch = latchOnConnectionLoss(fake.store, () => {
      throw new Error("must not be called");
    });
    const ref = { executionId: "e", generation: 1 };

    await expect(latch.store.desiredStateOf(ref)).rejects.toBe(cancelled);
    await expect(latch.store.desiredStateOf(ref)).rejects.toBe(cancelled);
    expect(latch.lost()).toBeUndefined();
    expect(fake.calls).toEqual(["desiredStateOf", "desiredStateOf"]);
  });
});

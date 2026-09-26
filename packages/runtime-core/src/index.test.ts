import { describe, expect, test } from "bun:test";
import type { AgentRun, AgentRuntime, RuntimeConfig } from "./index.ts";

describe("runtime-core contracts", () => {
  test("RuntimeConfig carries the mode instead of separate entry points", () => {
    const fresh: RuntimeConfig = {
      correlationId: "c",
      cwd: "/w",
      home: "/h",
      mode: "new",
      model: "m",
      tools: [],
    };
    const resumed: RuntimeConfig = { ...fresh, mode: "resume", resume: "s" };
    // @ts-expect-error resume mode needs the handle
    const invalid: RuntimeConfig = { ...fresh, mode: "resume" };
    expect([fresh.mode, resumed.mode, invalid.mode]).toEqual([
      "new",
      "resume",
      "resume",
    ]);
  });

  // `satisfies` fails the type check on a member missing here or one the
  // interface no longer has; the runtime assertion cannot see either.
  test("the listed members are exactly AgentRuntime's and AgentRun's", () => {
    const runtimeMembers = {
      capabilities: true,
      start: true,
    } satisfies Record<keyof AgentRuntime, true>;
    const runMethods = {
      abort: true,
      close: true,
      events: true,
      finishInput: true,
      holdsInput: true,
      interrupt: true,
      leaseCheckpoint: true,
      prepareCheckpoint: true,
      ready: true,
      send: true,
    } satisfies Record<
      Exclude<keyof AgentRun, typeof Symbol.asyncIterator>,
      true
    >;
    expect(Object.keys(runtimeMembers)).toHaveLength(2);
    expect(Object.keys(runMethods)).toHaveLength(10);
  });
});

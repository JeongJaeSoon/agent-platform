import { describe, expect, test } from "bun:test";
import type { AgentRun, AgentRuntime, RuntimeStartConfig } from "./index.ts";

describe("runtime-core contracts", () => {
  test("RuntimeStartConfig carries the mode instead of separate entry points", () => {
    const fresh: RuntimeStartConfig = {
      correlationId: "c",
      cwd: "/w",
      home: "/h",
      mode: "new",
      model: "m",
      permissionMode: "default",
      tools: [],
    };
    const resumed: RuntimeStartConfig = {
      ...fresh,
      mode: "resume",
      resume: "s",
    };
    // @ts-expect-error resume mode needs the handle
    const invalid: RuntimeStartConfig = { ...fresh, mode: "resume" };
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
      descriptor: true,
      start: true,
    } satisfies Record<keyof AgentRuntime, true>;
    const runMethods = {
      abort: true,
      answer: true,
      close: true,
      events: true,
      finishInput: true,
      holdsInput: true,
      interrupt: true,
      leaseCheckpoint: true,
      parkable: true,
      prepareCheckpoint: true,
      ready: true,
      send: true,
    } satisfies Record<keyof AgentRun, true>;
    expect(Object.keys(runtimeMembers)).toHaveLength(2);
    expect(Object.keys(runMethods)).toHaveLength(12);
  });
});

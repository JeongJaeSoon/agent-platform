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
    const keys: Array<keyof AgentRuntime> = ["capabilities", "start"];
    const runKeys: Array<keyof AgentRun> = [
      "send",
      "events",
      "interrupt",
      "abort",
      "close",
      "prepareCheckpoint",
    ];
    expect(keys.length + runKeys.length).toBe(8);
  });
});

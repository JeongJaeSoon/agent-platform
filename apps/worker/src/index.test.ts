import { describe, expect, test } from "bun:test";

import { ClaudeSdkRuntime, FakeAgentRuntime } from "./index.ts";

describe("worker composition surface", () => {
  test("exposes the Claude runtime and its fake through the adapter package", () => {
    expect(typeof ClaudeSdkRuntime).toBe("function");
    expect(new FakeAgentRuntime([]).capabilities).toEqual({
      checkpoint: true,
      interrupt: true,
      resume: true,
    });
  });
});

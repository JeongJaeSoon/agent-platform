import { describe, expect, test } from "bun:test";

import type { RuntimeDescriptor } from "./descriptor.ts";
import {
  type RuntimeModule,
  RuntimeRegistry,
  UnsupportedRuntime,
} from "./module.ts";

function moduleFor(kind: RuntimeDescriptor["kind"]): RuntimeModule {
  return {
    descriptor: { kind } as RuntimeDescriptor,
    checkpointCodec: {} as RuntimeModule["checkpointCodec"],
    assertCompatible: () => {},
    fingerprint: () => ({}) as ReturnType<RuntimeModule["fingerprint"]>,
    createRuntime: () => {
      throw new Error("not used");
    },
    imageFingerprint: () => kind,
  };
}

describe("RuntimeRegistry", () => {
  test("serves the module installed for a kind", () => {
    const claude = moduleFor("claude_agent_sdk");
    const registry = new RuntimeRegistry([claude]);

    expect(registry.require("claude_agent_sdk")).toBe(claude);
    expect(registry.descriptors()).toEqual([claude.descriptor]);
  });

  test("refuses a kind nobody installed, naming what is", () => {
    const registry = new RuntimeRegistry([moduleFor("claude_agent_sdk")]);

    expect(() => registry.require("codex_app_server")).toThrow(
      new UnsupportedRuntime(
        "This worker runs claude_agent_sdk, not codex_app_server",
      ),
    );
  });

  test("refuses two modules for one kind", () => {
    expect(
      () =>
        new RuntimeRegistry([
          moduleFor("claude_agent_sdk"),
          moduleFor("claude_agent_sdk"),
        ]),
    ).toThrow("Runtime claude_agent_sdk is installed twice");
  });
});

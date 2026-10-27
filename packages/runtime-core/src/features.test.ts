import { describe, expect, test } from "bun:test";

import type { RuntimeCapabilityTable } from "./descriptor.ts";
import {
  featureSupport,
  runtimeRequirementsOf,
  unmetFeatures,
} from "./features.ts";

const table: RuntimeCapabilityTable = {
  interrupt: true,
  checkpoint: true,
  approvalCheckpoint: false,
  resume: true,
  mcp: "native",
  skills: "none",
  permissionModes: {
    default: "native",
    acceptEdits: "native",
    dontAsk: "native",
    plan: "native",
    bypassPermissions: "native",
    auto: "native",
  },
};
const mcpServer = {
  name: "docs",
  endpoint: "https://mcp.example.invalid/mcp",
  binding: `sha256:${"0".repeat(64)}`,
  access: { kind: "egress_token", token: "t" },
} as const;

describe("runtimeRequirementsOf", () => {
  test("asks for nothing beyond what every engine runs", () => {
    expect(runtimeRequirementsOf({ permission_mode: "default" })).toEqual({
      features: [],
    });
  });

  test("asks for mcp with a server and a classifier in auto mode", () => {
    expect(
      runtimeRequirementsOf({
        permission_mode: "auto",
        mcp_servers: [mcpServer],
      }),
    ).toEqual({ features: ["mcp", "classifier_review"] });
  });
});

describe("featureSupport", () => {
  test("reads table features from the table, ignoring the extras", () => {
    expect(featureSupport(table, { mcp: "none" }, "mcp")).toBe("native");
    expect(featureSupport(table, { skills: "native" }, "skills")).toBe("none");
  });

  test("derives resume and park from the boolean capabilities", () => {
    expect(featureSupport(table, {}, "session_resume")).toBe("native");
    expect(featureSupport(table, {}, "approval_park")).toBe("native");
    const noResume = { ...table, resume: false };
    expect(featureSupport(noResume, {}, "session_resume")).toBe("none");
    expect(featureSupport(noResume, {}, "approval_park")).toBe("none");
  });

  test("takes only a native auto mode as a classifier", () => {
    const emulated = {
      ...table,
      permissionModes: { ...table.permissionModes, auto: "emulated" as const },
    };
    expect(featureSupport(emulated, {}, "classifier_review")).toBe("none");
  });

  test("defaults an extra feature nobody declared to none", () => {
    expect(featureSupport(table, {}, "user_hooks")).toBe("none");
    expect(featureSupport(table, { subagents: "emulated" }, "subagents")).toBe(
      "emulated",
    );
  });
});

describe("unmetFeatures", () => {
  test("is empty when every required feature is supported", () => {
    expect(
      unmetFeatures(table, {}, { features: ["mcp", "classifier_review"] }),
    ).toEqual([]);
  });

  test("counts emulated as met and lists what is missing in order", () => {
    const partial = { ...table, mcp: "emulated" as const };
    expect(
      unmetFeatures(
        partial,
        { subagents: "emulated" },
        { features: ["user_hooks", "mcp", "subagents", "skills"] },
      ),
    ).toEqual(["user_hooks", "skills"]);
  });
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_MIGRATION_HELPER_IMAGE } from "@agent-platform/execution-local-docker";
import { parseMigrateWorkspaceArgs } from "./migrate-workspace.ts";

describe("parseMigrateWorkspaceArgs", () => {
  test("takes session ids with the pinned helper and an hour by default", () => {
    expect(parseMigrateWorkspaceArgs(["s-1", "s-2"], {})).toEqual({
      deadlineMs: 3_600_000,
      helperImage: DEFAULT_MIGRATION_HELPER_IMAGE,
      sessionIds: ["s-1", "s-2"],
    });
  });

  test("the helper comes from the flag, then the environment", () => {
    const pinned = `busybox@sha256:${"a".repeat(64)}`;
    expect(
      parseMigrateWorkspaceArgs(["s-1"], {
        EXECUTION_WORKSPACE_MIGRATION_IMAGE: pinned,
      }).helperImage,
    ).toBe(pinned);
    expect(
      parseMigrateWorkspaceArgs(["--helper-image", "x@sha256:1", "s-1"], {
        EXECUTION_WORKSPACE_MIGRATION_IMAGE: pinned,
      }).helperImage,
    ).toBe("x@sha256:1");
  });

  test("a deadline must be a whole number of seconds", () => {
    expect(
      parseMigrateWorkspaceArgs(["--deadline-sec", "90", "s-1"], {}).deadlineMs,
    ).toBe(90_000);
    expect(() =>
      parseMigrateWorkspaceArgs(["--deadline-sec", "1.5", "s-1"], {}),
    ).toThrow("not a positive integer");
    expect(() =>
      parseMigrateWorkspaceArgs(["--deadline-sec", "0", "s-1"], {}),
    ).toThrow("not a positive integer");
  });

  test("no session, a dangling flag or an unknown one is a usage error", () => {
    expect(() => parseMigrateWorkspaceArgs([], {})).toThrow("usage:");
    expect(() => parseMigrateWorkspaceArgs(["--helper-image"], {})).toThrow(
      "needs a value",
    );
    expect(() => parseMigrateWorkspaceArgs(["--force", "s-1"], {})).toThrow(
      "unknown option --force",
    );
  });
});

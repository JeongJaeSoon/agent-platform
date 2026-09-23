import { describe, expect, test } from "bun:test";
import { describeGrantsResult, parseGrantsCommand } from "./grants.ts";

const SESSION = "0B9F1C2E-6A4D-4E8B-9C3F-1D2E3F4A5B6C";

describe("grants CLI arguments", () => {
  test("revoke and restore take one session UUID and a reason", () => {
    expect(
      parseGrantsCommand(["revoke", SESSION, "--reason", " leaked token "]),
    ).toEqual({
      command: "revoke",
      sessionId: SESSION.toLowerCase(),
      reason: "leaked token",
    });
    expect(
      parseGrantsCommand(["restore", SESSION, "--reason=reissued"]),
    ).toEqual({
      command: "restore",
      sessionId: SESSION.toLowerCase(),
      reason: "reissued",
    });
  });

  test("a missing or blank reason is refused: the audit record needs one", () => {
    expect(() => parseGrantsCommand(["revoke", SESSION])).toThrow(
      "--reason is required",
    );
    expect(() =>
      parseGrantsCommand(["revoke", SESSION, "--reason", "  "]),
    ).toThrow("--reason is required");
  });

  test("an unknown command, a non-UUID, an extra argument or flag is refused", () => {
    for (const argv of [
      ["delete", SESSION, "--reason", "x"],
      ["revoke", "--reason", "x"],
      ["revoke", SESSION, "extra", "--reason", "x"],
      ["revoke", SESSION, "--reason", "x", "--owner", "o"],
    ]) {
      expect(() => parseGrantsCommand(argv)).toThrow("Usage");
    }
    expect(() =>
      parseGrantsCommand(["revoke", "not-a-uuid", "--reason", "x"]),
    ).toThrow("session_id must be a UUID");
  });
});

describe("grants CLI output", () => {
  test("only a command that did what it asked exits zero", () => {
    const id = SESSION.toLowerCase();
    expect(
      describeGrantsResult(id, {
        outcome: "revoked",
        ownerId: "owner-a",
        receiptId: "r1",
        receiptStatus: "accepted",
        authRevision: 3,
        executionId: "exec-1",
        revokedCredentials: 1,
      }),
    ).toEqual({
      ok: true,
      line: `revoked ${id} owner=owner-a auth_revision=3 execution=exec-1 credentials_revoked=1 receipt=r1 receipt_status=accepted`,
    });
    expect(
      describeGrantsResult(id, {
        outcome: "already_revoked",
        revokedAt: new Date("2026-09-24T00:00:00.000Z"),
        reason: "leaked",
      }).ok,
    ).toBe(true);
    for (const result of [
      { outcome: "not_found" as const },
      { outcome: "closed" as const },
      { outcome: "unsupported" as const },
      { outcome: "execution_unconfirmed" as const, executionId: "exec-1" },
    ]) {
      expect(describeGrantsResult(id, result).ok).toBe(false);
    }
  });
});

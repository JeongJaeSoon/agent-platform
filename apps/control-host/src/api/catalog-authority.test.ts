import { describe, expect, test } from "bun:test";
import {
  describeActivation,
  parseCatalogAuthorityCommand,
} from "./catalog-authority.ts";

const A = `sha256:${"a".repeat(64)}`;
const B = `sha256:${"b".repeat(64)}`;

describe("catalog authority CLI arguments (94S-295)", () => {
  test("show takes nothing; activate takes a revision and what it replaces", () => {
    expect(parseCatalogAuthorityCommand(["show"])).toEqual({ command: "show" });
    expect(
      parseCatalogAuthorityCommand(["activate", B, "--expected", A]),
    ).toEqual({ command: "activate", revision: B, expected: A });
    expect(
      parseCatalogAuthorityCommand(["activate", A, "--expected=none"]),
    ).toEqual({ command: "activate", revision: A, expected: null });
  });

  test("activate without --expected is refused: nobody replaces an activation unseen", () => {
    expect(() => parseCatalogAuthorityCommand(["activate", A])).toThrow(
      "--expected is required",
    );
  });

  test("a revision not shaped like the logged one, an unknown command or an extra argument is refused", () => {
    expect(() =>
      parseCatalogAuthorityCommand([
        "activate",
        "a".repeat(64),
        "--expected",
        "none",
      ]),
    ).toThrow("revision must be sha256:");
    expect(() =>
      parseCatalogAuthorityCommand(["activate", A, "--expected", "latest"]),
    ).toThrow('--expected must be a revision or "none"');
    for (const argv of [
      ["clear"],
      ["show", A],
      ["show", "--expected", "none"],
      ["activate", A, B, "--expected", "none"],
      ["activate", A, "--expected", "none", "--force"],
    ]) {
      expect(() => parseCatalogAuthorityCommand(argv)).toThrow("Usage");
    }
  });
});

describe("catalog authority CLI output", () => {
  test("only an activation that happened exits zero, and a conflict names what is active", () => {
    const at = new Date("2026-09-24T00:00:00.000Z");
    expect(
      describeActivation({
        outcome: "activated",
        authority: { revision: B, activatedAt: at },
      }),
    ).toEqual({
      ok: true,
      line: `activated ${B} activated_at=2026-09-24T00:00:00.000Z`,
    });
    expect(
      describeActivation({
        outcome: "conflict",
        current: { revision: A, activatedAt: at },
      }),
    ).toEqual({
      ok: false,
      line: `conflict: the active revision is ${A} activated_at=2026-09-24T00:00:00.000Z; nothing changed`,
    });
    expect(
      describeActivation({ outcome: "conflict", current: null }).line,
    ).toBe("conflict: the active revision is none; nothing changed");
  });
});

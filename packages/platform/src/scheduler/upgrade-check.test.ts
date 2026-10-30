import { describe, expect, test } from "bun:test";
import {
  type AffectedSession,
  assessUpgrade,
  type UpgradeSession,
} from "./upgrade-check.ts";

const current = {
  cliVersion: "2.1.280",
  engine: "claude",
  profileDigestScheme: 1,
  sdkVersion: "0.3.280",
};
const previous = { ...current, cliVersion: "2.1.270", sdkVersion: "0.3.270" };
const older = { ...current, cliVersion: "2.1.260", sdkVersion: "0.3.260" };

const on = (
  sessionId: string,
  image: typeof current | null,
): UpgradeSession => ({
  sessionId,
  pointer:
    image === null
      ? { kind: "unrecorded" }
      : { kind: "recorded", runtime: image },
});

const upgrade = {
  deployedWorker: "worker@sha256:n",
  targetWorker: "worker@sha256:n1",
  targetPreviousWorker: "worker@sha256:n",
  runtimes: { current, previous },
};

describe("assessUpgrade", () => {
  test("sessions on either target image, or with no pointer, need no approval", () => {
    expect(
      assessUpgrade({
        ...upgrade,
        sessions: [
          on("s-current", current),
          on("s-previous", previous),
          { sessionId: "s-fresh", pointer: { kind: "none" } },
        ],
        approved: [],
      }),
    ).toEqual({ verdict: "proceed", affected: [], approved: [] });
  });

  test("a session on neither image, or with an unrecorded pointer, stops the upgrade until approved exactly", () => {
    const sessions = [
      on("s-current", current),
      on("s-unrecorded", null),
      on("s-older", older),
    ];
    const affected: AffectedSession[] = [
      { sessionId: "s-older", reason: "no_image" },
      { sessionId: "s-unrecorded", reason: "unrecorded" },
    ];

    const unapproved = assessUpgrade({ ...upgrade, sessions, approved: [] });
    expect(unapproved.verdict).toBe("refused");
    expect(unapproved.affected).toEqual(affected);
    expect(unapproved.reason).toContain(
      "not approved: s-older s-unrecorded; no longer affected: none",
    );

    const short = assessUpgrade({
      ...upgrade,
      sessions,
      approved: ["s-older"],
    });
    expect(short.verdict).toBe("refused");
    expect(short.reason).toContain("not approved: s-unrecorded");

    const extra = assessUpgrade({
      ...upgrade,
      sessions,
      approved: ["s-older", "s-unrecorded", "s-gone"],
    });
    expect(extra.verdict).toBe("refused");
    expect(extra.reason).toContain("no longer affected: s-gone");

    expect(
      assessUpgrade({
        ...upgrade,
        sessions,
        approved: ["s-unrecorded", "s-older", "s-older"],
      }),
    ).toEqual({
      verdict: "proceed",
      affected,
      approved: ["s-older", "s-unrecorded"],
    });
  });

  test("the same engine build under another profile digest scheme runs on neither image", () => {
    expect(
      assessUpgrade({
        ...upgrade,
        sessions: [on("s-scheme", { ...previous, profileDigestScheme: 2 })],
        approved: [],
      }).affected,
    ).toEqual([{ sessionId: "s-scheme", reason: "no_image" }]);
  });

  test("a target whose previous image is not the deployed one is refused, approved or not, still listing what would break", () => {
    for (const targetPreviousWorker of ["worker@sha256:other", null]) {
      const assessment = assessUpgrade({
        ...upgrade,
        targetPreviousWorker,
        sessions: [on("s-older", older)],
        approved: ["s-older"],
      });
      expect(assessment.verdict).toBe("refused");
      expect(assessment.reason).toContain("is not the deployed one");
      expect(assessment.affected).toEqual([
        { sessionId: "s-older", reason: "no_image" },
      ]);
    }
  });

  test("an unchanged worker image goes ahead without looking at sessions", () => {
    expect(
      assessUpgrade({
        ...upgrade,
        targetWorker: upgrade.deployedWorker,
        targetPreviousWorker: null,
        sessions: [on("s-older", older)],
        approved: [],
      }),
    ).toEqual({ verdict: "proceed", affected: [], approved: [] });
  });

  test("a stale approval left in the values is refused even when nothing is affected", () => {
    const changed = assessUpgrade({
      ...upgrade,
      sessions: [on("s-current", current)],
      approved: ["s-gone"],
    });
    expect(changed.verdict).toBe("refused");
    expect(changed.reason).toContain("no longer affected: s-gone");

    const unchanged = assessUpgrade({
      ...upgrade,
      targetWorker: upgrade.deployedWorker,
      sessions: [],
      approved: ["s-gone"],
    });
    expect(unchanged.verdict).toBe("refused");
    expect(unchanged.reason).toContain("must be empty");
  });
});

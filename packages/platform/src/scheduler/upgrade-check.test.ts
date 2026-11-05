import { describe, expect, test } from "bun:test";
import {
  type AffectedSession,
  assessNothingReplaced,
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

  describe("the worker image stays and the deployed previous image goes", () => {
    const kept = {
      ...upgrade,
      deployedWorker: "worker@sha256:n1",
      deployedPreviousWorker: "worker@sha256:n",
      runtimes: { current, previous: null },
      targetPreviousWorker: null,
    };

    test("lists a session sealed on the dropped image and refuses until it is approved", () => {
      const sessions = [on("s-previous", previous), on("s-current", current)];
      const refused = assessUpgrade({ ...kept, sessions, approved: [] });
      expect(refused.verdict).toBe("refused");
      expect(refused.affected).toEqual([
        { sessionId: "s-previous", reason: "no_image" },
      ]);
      expect(refused.reason).toContain("deployed previous image");

      expect(
        assessUpgrade({ ...kept, sessions, approved: ["s-previous"] }).verdict,
      ).toBe("proceed");
    });

    test("proceeds when no session was sealed on it", () => {
      expect(
        assessUpgrade({
          ...kept,
          sessions: [on("s-current", current)],
          approved: [],
        }),
      ).toEqual({ verdict: "proceed", affected: [], approved: [] });
    });

    test("a previous image that is kept, or that the deployed release never had, compares nothing", () => {
      for (const overrides of [
        {
          targetPreviousWorker: "worker@sha256:n",
          runtimes: { current, previous },
        },
        { deployedPreviousWorker: null },
      ]) {
        expect(
          assessUpgrade({
            ...kept,
            ...overrides,
            sessions: [on("s-older", older)],
            approved: [],
          }),
        ).toEqual({ verdict: "proceed", affected: [], approved: [] });
      }
    });
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

describe("assessNothingReplaced", () => {
  test("proceeds with no approvals, saying nothing about any session", () => {
    expect(assessNothingReplaced([], "nothing was deployed")).toEqual({
      verdict: "proceed",
      affected: [],
      approved: [],
    });
  });

  test("refuses a stale approval and says why it does not apply", () => {
    const stale = assessNothingReplaced(
      ["s-2", "s-1", "s-1"],
      "nothing was deployed",
    );
    expect(stale.verdict).toBe("refused");
    expect(stale.approved).toEqual(["s-1", "s-2"]);
    expect(stale.reason).toStartWith("nothing was deployed, so");
    expect(stale.reason).toContain("no longer affected: s-1 s-2");
  });
});

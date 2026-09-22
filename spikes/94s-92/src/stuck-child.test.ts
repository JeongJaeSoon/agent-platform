import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { groupMembers, isAlive } from "./process-group.ts";
import {
  CLEANUP_WAITS,
  reapStuckChild,
  SIGNAL_GRACE_MS,
  WATCHDOG_MARGIN_MS,
} from "./stuck-child.ts";

/**
 * Two things have to hold at once. The watchdog fires `WATCHDOG_MARGIN_MS`
 * before bun's own test timeout and has to finish inside it, or bun kills the
 * test first and the diagnosis — the point of the watchdog — is lost. And the
 * cleanup has to reach descendants that appear *after* it started, which is
 * exactly what a PID-tree walk cannot promise.
 */
describe("reapStuckChild", () => {
  test("takes down a group whose members ignore SIGTERM and fork mid-cleanup", async () => {
    // Traps TERM, keeps one grandchild from the start and spawns another after
    // the cleanup is already under way.
    const child = spawn(
      "sh",
      ["-c", 'trap "" TERM; sleep 30 & sleep 2; sleep 30 & wait'],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    const pgid = child.pid;
    if (pgid === undefined) throw new Error("child has no pid");
    const settled = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    let members: number[] = [];
    for (let attempt = 0; attempt < 50 && members.length < 2; attempt += 1) {
      await Bun.sleep(20);
      members = groupMembers(pgid);
    }
    expect(members.length).toBeGreaterThanOrEqual(2);

    const startedAt = Date.now();
    const notes = await reapStuckChild(child, settled);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(WATCHDOG_MARGIN_MS);
    expect(notes.join("\n")).toContain("after SIGKILL");
    // The second sleeper is spawned 2s in, during the SIGTERM grace period.
    // A snapshot taken before the signal would not contain it.
    expect(groupMembers(pgid)).toEqual([]);
    expect(members.filter(isAlive)).toEqual([]);
  }, 20_000);

  test("keeps a margin wider than every wait the timeout path can stack", () => {
    // Arithmetic, not runtime: this is what breaks if someone adds another
    // bounded wait to the cleanup without widening the budget that guards it.
    // The watchdog fires this early, so the whole path has to fit inside it.
    expect(WATCHDOG_MARGIN_MS).toBeGreaterThan(CLEANUP_WAITS * SIGNAL_GRACE_MS);
  });

  test("reports a child that is already gone without waiting out the grace periods", async () => {
    const child = spawn("sh", ["-c", "exit 0"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const settled = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    await settled;

    const startedAt = Date.now();
    const notes = await reapStuckChild(child, settled);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(notes.join("\n")).toContain("settled=true");
  }, 10_000);
});

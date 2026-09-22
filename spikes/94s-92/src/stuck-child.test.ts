import { describe, expect, test } from "bun:test";
import { isAlive, processTree } from "./process-tree.ts";
import { reapStuckChild, WATCHDOG_MARGIN_MS } from "./stuck-child.ts";

/**
 * The watchdog fires `WATCHDOG_MARGIN_MS` before bun's own test timeout and
 * then has to finish inside it. If cleanup outlives the margin, bun kills the
 * test first and the diagnosis — the whole point of the watchdog — is lost.
 */
describe("reapStuckChild", () => {
  test("finishes inside the watchdog margin against a child that ignores SIGTERM", async () => {
    // Traps TERM and keeps a grandchild alive, so every branch of the cleanup
    // is exercised: the sweep, the ignored SIGTERM, and the SIGKILL.
    const child = Bun.spawn({
      cmd: ["sh", "-c", 'trap "" TERM; sleep 30 & wait'],
      stderr: "ignore",
      stdout: "ignore",
    });
    if (child.pid === undefined) throw new Error("child has no pid");
    const settled = child.exited;

    let tree: number[] = [];
    for (let attempt = 0; attempt < 50 && tree.length < 2; attempt += 1) {
      await Bun.sleep(20);
      tree = processTree(child.pid);
    }
    expect(tree.length).toBeGreaterThanOrEqual(2);

    const startedAt = Date.now();
    const notes = await reapStuckChild(child, settled);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(WATCHDOG_MARGIN_MS);
    expect(notes.join("\n")).toContain("descendants reaped:");
    await settled;
    expect(tree.filter(isAlive)).toEqual([]);
  }, 20_000);

  test("reports a child that is already gone without waiting out the grace periods", async () => {
    const child = Bun.spawn({
      cmd: ["sh", "-c", "exit 0"],
      stderr: "ignore",
      stdout: "ignore",
    });
    const settled = child.exited;
    await settled;

    const startedAt = Date.now();
    const notes = await reapStuckChild(child, settled);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(notes.join("\n")).toContain("settled=true");
  }, 10_000);
});

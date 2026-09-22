import { describe, expect, test } from "bun:test";
import { isAlive, killTree, processTree } from "./process-tree.ts";

/**
 * The watchdog's cleanup is only as good as this: if the tree walk stops at the
 * direct child, a surviving grandchild keeps running against the fake API and
 * LocalStack while the next test is already using them.
 */
describe("processTree", () => {
  test("finds a grandchild and kills the whole tree", async () => {
    // The trailing `:` matters: a shell given a single command execs it and
    // leaves no tree at all.
    const child = Bun.spawn({
      cmd: ["sh", "-c", "sleep 30; :"],
      stderr: "ignore",
      stdout: "ignore",
    });
    if (child.pid === undefined) throw new Error("child has no pid");

    let tree: number[] = [];
    for (let attempt = 0; attempt < 50 && tree.length < 2; attempt += 1) {
      await Bun.sleep(20);
      tree = processTree(child.pid);
    }

    expect(tree.length).toBeGreaterThanOrEqual(2);
    // Deepest first, so a parent is never signalled before its own children.
    expect(tree.at(-1)).toBe(child.pid);
    const grandchild = tree[0];
    if (grandchild === undefined) throw new Error("no grandchild");
    expect(isAlive(grandchild)).toBe(true);

    killTree(tree, "SIGKILL");
    await child.exited;
    for (let attempt = 0; attempt < 50 && isAlive(grandchild); attempt += 1) {
      await Bun.sleep(20);
    }
    expect(isAlive(grandchild)).toBe(false);
  }, 15_000);

  test("reports a lone process as its own tree", () => {
    expect(processTree(process.pid).at(-1)).toBe(process.pid);
  });
});

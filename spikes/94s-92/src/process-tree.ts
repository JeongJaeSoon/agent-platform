/**
 * Process-tree accounting for the suite's watchdog.
 *
 * `Bun.spawn` starts the child in this process's own group, and the Agent SDK
 * spawns the Claude CLI below it. Signalling only the direct child therefore
 * leaves the CLI running: it does not hold the child's stdout open — the SDK
 * gives it its own pipes — but it keeps talking to the fake API and to S3 while
 * later tests run. A watchdog that fires must take the whole tree with it.
 */

/** `pid` and everything below it, deepest first so parents die last. */
export function processTree(pid: number): number[] {
  const nested = childrenOf(pid).flatMap(processTree);
  return [...nested, pid];
}

/** Sends `signal` to every pid, ignoring the ones that are already gone. */
export function killTree(
  pids: readonly number[],
  signal: NodeJS.Signals,
): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already reaped, or never ours to signal. Either way there is nothing
      // left to do about this pid.
    }
  }
}

/**
 * Kills everything below `pid`, sweeping until nothing new appears.
 *
 * One snapshot is not enough: a descendant can fork while the sweep runs, and
 * once its parent is gone it is reparented and `pgrep -P` can no longer reach
 * it from here. So `pid` itself is deliberately left alive — it is the only
 * handle by which its children stay findable. Returns every pid it signalled.
 */
export async function reapDescendants(
  pid: number,
  sweeps = 5,
): Promise<number[]> {
  const signalled = new Set<number>();
  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    const descendants = processTree(pid).filter((found) => found !== pid);
    if (descendants.length === 0 && sweep > 0) break;
    for (const descendant of descendants) signalled.add(descendant);
    killTree(descendants, "SIGKILL");
    await Bun.sleep(25);
  }
  return [...signalled];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childrenOf(pid: number): number[] {
  let stdout = "";
  try {
    // `pgrep -P` is the one portable way to walk children on both macOS and the
    // Linux runners; `ps --ppid` is GNU-only.
    stdout = Bun.spawnSync(["pgrep", "-P", String(pid)], {
      stderr: "ignore",
      stdout: "pipe",
    }).stdout.toString();
  } catch {
    return [];
  }
  return stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

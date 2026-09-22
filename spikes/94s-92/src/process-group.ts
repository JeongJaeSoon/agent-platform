/**
 * Process-group cleanup for the suite's watchdog.
 *
 * Walking a PID tree cannot guarantee anything here: a descendant that forks
 * after the last snapshot is reparented the moment its parent dies, and
 * `pgrep -P` can no longer reach it. A child started with `detached: true`
 * leads its own group instead, so one signal to the negative pid reaches
 * everything the Agent SDK spawned below it — including the Claude CLI — with
 * no window to escape through.
 *
 * Such a survivor would not hold the child's stdout open; the SDK gives the CLI
 * its own pipes. It would keep talking to the fake API and to LocalStack while
 * the next test is already using them, which is the contamination this avoids.
 */

/** Every pid still in `pgid`'s group, the leader included. */
export function groupMembers(pgid: number): number[] {
  let stdout = "";
  try {
    stdout = Bun.spawnSync(["pgrep", "-g", String(pgid)], {
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

/**
 * Signals the whole group. Returns false when the group is already empty,
 * which is the only reason `kill` is allowed to fail here.
 */
export function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

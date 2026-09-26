/**
 * Per-process ceilings, applied with `setrlimit` before git starts and
 * inherited by every helper it forks: each of `fetch` and its `index-pack`
 * gets the whole budget, so a caller sizing them adds them up.
 */
export type GitResourceLimits = {
  /** Soft and hard `RLIMIT_CPU`; git is killed once it has used this much. */
  readonly cpuSeconds: number;
  /** `RLIMIT_FSIZE`: no single file git writes may grow past this. */
  readonly fileSizeBytes: number;
  /**
   * `RLIMIT_AS`: address space, so the file mappings git reads packs through
   * count as well as the heap. An allocation past it fails and git dies
   * with "Out of memory".
   */
  readonly memoryBytes: number;
};

/**
 * Absolute, so that a caller's `PATH` decides which git runs but never which
 * program applies the limits. util-linux installs it here on Debian, Ubuntu
 * and Alpine alike.
 */
const PRLIMIT = "/usr/bin/prlimit";

let warnedUnenforced = false;

/**
 * The command line that runs `git args` under `limits`.
 *
 * `prlimit` sets the limits and then execs git, so the pid, process group and
 * exit status stay git's own. Only Linux takes it: macOS refuses to lower
 * `RLIMIT_AS`, so there the limits are announced as missing once and git runs
 * as before. On Linux nothing falls back — a missing `prlimit` fails the
 * spawn rather than running git without the limits it was promised.
 */
export function gitCommand(
  args: readonly string[],
  limits: GitResourceLimits | undefined,
): string[] {
  if (limits === undefined) return ["git", ...args];
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`git limit ${name} must be a positive integer`);
    }
  }
  if (process.platform !== "linux") {
    if (!warnedUnenforced) {
      warnedUnenforced = true;
      console.warn(
        `git resource limits are not enforced on ${process.platform}; git runs with this process's memory, disk and CPU`,
      );
    }
    return ["git", ...args];
  }
  return [
    PRLIMIT,
    `--as=${limits.memoryBytes}`,
    `--fsize=${limits.fileSizeBytes}`,
    `--cpu=${limits.cpuSeconds}`,
    // A git killed by a limit would otherwise leave a core file the size
    // of what it had mapped.
    "--core=0",
    "--",
    "git",
    ...args,
  ];
}

/**
 * SIGKILLs the process group `pid` leads, or `pid` alone when it leads none.
 *
 * Only while the leader is known to be running: once its exit has been
 * reported it has been reaped, and when no helper is left in its group the
 * number may already belong to someone else's.
 */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

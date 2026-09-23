import { spawn } from "node:child_process";

export interface GitCommandResult {
  readonly exitCode: number;
  /** Set when something other than this runner killed git. */
  readonly signal?: string;
  /** Set when this runner killed git for running past `timeoutMs`. */
  readonly timedOut?: true;
  /** Set when a stream ran past `GIT_OUTPUT_LIMIT_BYTES` and was cut. */
  readonly truncated?: true;
  readonly stderr: string;
  readonly stdout: string;
}

export type GitCommandOptions = {
  /**
   * Drop every inherited `GIT_*` variable before adding `env`. Off by
   * default: session storage's clone and push rely on whatever TLS, SSH and
   * proxy settings the host carries. The verifier turns it on, because an
   * inherited `GIT_DIR`, `GIT_OBJECT_DIRECTORY` or
   * `GIT_ALTERNATE_OBJECT_DIRECTORIES` would let git answer for a repository
   * other than the empty one it was pointed at.
   */
  readonly clearGitEnvironment?: boolean;
  readonly cwd?: string;
  readonly env: Record<string, string>;
  /**
   * Caps each git process this call starts, helpers included, so that what
   * git is asked to index cannot take the host's memory, disk or CPU with it.
   * Unset means git shares whatever this process has.
   */
  readonly limits?: GitResourceLimits;
  /**
   * Kills git and reports `GIT_TIMEOUT_EXIT_CODE` once this many milliseconds
   * have passed. Unset means the caller accepts waiting as long as git takes.
   */
  readonly timeoutMs?: number;
};

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

export type GitCommandRunner = (
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

/** Exit code reported when the runner killed git for running past its timeout. */
export const GIT_TIMEOUT_EXIT_CODE = 124;

/**
 * Most of each stream kept, per invocation. Everything past it is drained
 * and dropped: a pack that makes fsck complain about every one of a million
 * objects must not be able to grow this process by what it says about them.
 */
export const GIT_OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * Absolute, so that a caller's `PATH` decides which git runs but never which
 * program applies the limits. util-linux installs it here on Debian, Ubuntu
 * and Alpine alike.
 */
const PRLIMIT = "/usr/bin/prlimit";

let warnedUnenforced = false;

/**
 * Runs git and hands back exit code and both streams.
 *
 * git is started in its own process group because it forks helpers
 * (`index-pack`, `pack-objects`) that inherit its pipes. Killing only the
 * leader on timeout would leave a helper holding the pipes open, and a runner
 * that waits for end-of-stream would then wait for the helper instead of the
 * timeout it promised.
 */
export function defaultGitRunner(
  args: readonly string[],
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    let launch: { command: string; argv: readonly string[] };
    try {
      launch = launcher(args, options.limits);
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(launch.command, launch.argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: true,
      env: {
        ...(options.clearGitEnvironment
          ? withoutGitVariables(process.env)
          : process.env),
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = boundedCollector();
    const stderr = boundedCollector();
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    let settled = false;
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
          }, options.timeoutMs);
    const settle = (result: () => GitCommandResult | Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const outcome = result();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    child.on("error", (error) => settle(() => error));
    // A timed-out git resolves on exit rather than on close: close waits for
    // every pipe holder, and the point of the timeout is not to.
    //
    // A git that fails on its own is not followed by a group kill: by the
    // time Node reports the exit it has reaped the leader, and the number may
    // already name someone else's group. A helper that outlives it — rare,
    // since index-pack ends when fetch's side of its stdin closes — is left
    // to the timeout, which fires while the group is still ours.
    child.on("exit", () => {
      if (timedOut) {
        settle(() => ({
          exitCode: GIT_TIMEOUT_EXIT_CODE,
          stderr: `git exceeded ${options.timeoutMs}ms`,
          stdout: "",
          timedOut: true,
        }));
      }
    });
    child.on("close", (code, signal) =>
      settle(() => ({
        // Killed by a signal: no code, and not a success.
        exitCode: code ?? 128,
        ...(signal === null ? {} : { signal }),
        stderr: stderr.text(),
        stdout: stdout.text(),
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
      })),
    );
  });
}

/**
 * `prlimit` sets the limits and then execs git, so the pid, process group and
 * exit status stay git's own. Only Linux takes it: macOS refuses to lower
 * `RLIMIT_AS`, so there the limits are announced as missing once and git runs
 * as before. On Linux nothing falls back — a missing `prlimit` fails the
 * spawn rather than running git without the limits it was promised.
 */
function launcher(
  args: readonly string[],
  limits: GitResourceLimits | undefined,
): { command: string; argv: readonly string[] } {
  if (limits === undefined) return { command: "git", argv: args };
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
    return { command: "git", argv: args };
  }
  return {
    command: PRLIMIT,
    argv: [
      `--as=${limits.memoryBytes}`,
      `--fsize=${limits.fileSizeBytes}`,
      `--cpu=${limits.cpuSeconds}`,
      // A git killed by a limit would otherwise leave a core file the size
      // of what it had mapped.
      "--core=0",
      "--",
      "git",
      ...args,
    ],
  };
}

function boundedCollector() {
  const chunks: Buffer[] = [];
  let kept = 0;
  const collector = {
    truncated: false,
    push(chunk: Buffer) {
      if (kept >= GIT_OUTPUT_LIMIT_BYTES) {
        collector.truncated = true;
        return;
      }
      const room = GIT_OUTPUT_LIMIT_BYTES - kept;
      if (chunk.byteLength > room) {
        chunks.push(chunk.subarray(0, room));
        kept = GIT_OUTPUT_LIMIT_BYTES;
        collector.truncated = true;
      } else {
        chunks.push(chunk);
        kept += chunk.byteLength;
      }
    },
    text() {
      return Buffer.concat(chunks).toString();
    },
  };
  return collector;
}

function withoutGitVariables(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !name.startsWith("GIT_")) kept[name] = value;
  }
  return kept;
}

function killGroup(pid: number | undefined): void {
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

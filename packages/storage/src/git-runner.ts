import { spawn } from "node:child_process";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type GitCommandOptions = {
  readonly cwd?: string;
  readonly env: Record<string, string>;
  /**
   * Kills git and reports `GIT_TIMEOUT_EXIT_CODE` once this many milliseconds
   * have passed. Unset means the caller accepts waiting as long as git takes.
   */
  readonly timeoutMs?: number;
};

export type GitCommandRunner = (
  args: readonly string[],
  options: GitCommandOptions,
) => Promise<GitCommandResult>;

/** Exit code reported when the runner killed git for running past its timeout. */
export const GIT_TIMEOUT_EXIT_CODE = 124;

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
    const child = spawn("git", args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      detached: true,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
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
    child.on("exit", () => {
      if (timedOut) {
        settle(() => ({
          exitCode: GIT_TIMEOUT_EXIT_CODE,
          stderr: `git exceeded ${options.timeoutMs}ms`,
          stdout: "",
        }));
      }
    });
    child.on("close", (code) =>
      settle(() => ({
        // Killed by a signal: no code, and not a success.
        exitCode: code ?? 128,
        stderr: Buffer.concat(stderr).toString(),
        stdout: Buffer.concat(stdout).toString(),
      })),
    );
  });
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

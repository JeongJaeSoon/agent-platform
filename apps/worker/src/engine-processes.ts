import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeProcessObserver } from "@agent-platform/runtime-claude";

/** What the host needs to know about the engine processes it started. */
export type EngineExitWatch = {
  /** Processes still descended from a live engine at a turn boundary. */
  descendants?(): Promise<number[]>;
  /** Resolves true once every spawned engine has exited, false on timeout. */
  exited(timeoutMs: number): Promise<boolean>;
  /** Engines that have not exited yet. */
  readonly running: number[];
  /** Force the stragglers down; the host calls it only after `exited` gave up. */
  kill(): void;
};

/**
 * The only evidence that an engine and its child actually went away.
 * `AgentRun.close()` and `abort()` return nothing and the frame stream can end
 * before the process does, so the host waits on the exit the spawn hook
 * observes rather than on either of those.
 */
export class EngineProcesses
  implements RuntimeProcessObserver, EngineExitWatch
{
  private readonly live = new Set<number>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly procRoot = "/proc",
    private readonly workspaceRoot?: string,
  ) {}

  get running(): number[] {
    return [...this.live];
  }

  onSpawn(pid: number): void {
    this.live.add(pid);
  }

  onExit(pid: number): void {
    this.live.delete(pid);
    if (this.live.size > 0) return;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async descendants(): Promise<number[]> {
    const descendants: number[] = [];
    const seen = new Set(this.live);
    const pending = [...this.live];
    while (pending.length > 0) {
      const parent = pending.shift() as number;
      const taskRoot = join(this.procRoot, String(parent), "task");
      const tasks = await readdir(taskRoot).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
          throw error;
        },
      );
      const childPids = new Set<number>();
      for (const task of tasks.filter((value) => /^\d+$/.test(value)).sort()) {
        const children = await readFile(
          join(taskRoot, task, "children"),
          "utf8",
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return "";
          throw error;
        });
        for (const value of children.trim().split(/\s+/)) {
          if (/^\d+$/.test(value)) childPids.add(Number(value));
        }
      }
      for (const child of [...childPids].sort((left, right) => left - right)) {
        if (seen.has(child)) continue;
        seen.add(child);
        descendants.push(child);
        pending.push(child);
      }
    }
    if (this.workspaceRoot !== undefined) {
      const processes = await readdir(this.procRoot).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
          throw error;
        },
      );
      const prefix = `${this.workspaceRoot}/`;
      for (const value of processes.filter((entry) => /^\d+$/.test(entry))) {
        const pid = Number(value);
        if (pid === process.pid || this.live.has(pid) || seen.has(pid))
          continue;
        const cwd = await readlink(join(this.procRoot, value, "cwd")).catch(
          (error: NodeJS.ErrnoException) => {
            if (
              error.code === "ENOENT" ||
              error.code === "ENOTDIR" ||
              error.code === "EACCES"
            ) {
              return undefined;
            }
            throw error;
          },
        );
        if (cwd === this.workspaceRoot || cwd?.startsWith(prefix) === true) {
          descendants.push(pid);
        }
      }
    }
    return descendants.sort((left, right) => left - right);
  }

  async exited(timeoutMs: number): Promise<boolean> {
    if (this.live.size === 0) return true;
    let wake: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<boolean>((resolve) => {
      wake = () => resolve(true);
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    this.waiters.add(wake);
    try {
      return await done;
    } finally {
      clearTimeout(timer);
      this.waiters.delete(wake);
    }
  }

  kill(): void {
    for (const pid of this.live) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone between the check and the signal; onExit follows.
      }
    }
  }
}

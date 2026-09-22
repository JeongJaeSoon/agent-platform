import type { RuntimeProcessObserver } from "@agent-platform/runtime-claude";

/** What the host needs to know about the engine processes it started. */
export type EngineExitWatch = {
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

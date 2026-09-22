import { stat } from "node:fs/promises";
import { join } from "node:path";

import { createWorkerHost } from "./composition.ts";
import { type WorkerEnvironment, workerConfigFromEnv } from "./config.ts";
import type { WorkerRunSummary } from "./worker-host.ts";

const DRAIN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * The worker process. It owns one session for as long as its lease holds, and
 * a signal here means "wind down", not "die": the drain the host runs is what
 * turns a container stop into a released session rather than an expired lease.
 */
export async function main(
  environment: NodeJS.ProcessEnv & WorkerEnvironment = process.env,
): Promise<WorkerRunSummary> {
  const config = workerConfigFromEnv(environment);
  await verifyWorkspace(config.runtime.cwd);
  const host = createWorkerHost(config);
  const handlers = DRAIN_SIGNALS.map((signal) => {
    const handler = () => host.drain(`received ${signal}`);
    process.on(signal, handler);
    return { signal, handler } as const;
  });
  try {
    return await host.runLoop();
  } finally {
    for (const { signal, handler } of handlers) {
      process.off(signal, handler);
    }
  }
}

/**
 * Checked before the session is claimed, because everything after the claim
 * costs somebody a turn. Every session names a repository, but the claim does
 * not yet say which one or who checks it out (94S-206), and the backend mounts
 * a volume it never fills. So the least this worker can insist on is a git
 * checkout: an empty or unprovisioned volume fails here rather than letting a
 * model run and edit files against nothing. Which repository and which commit
 * are the descriptor's to verify once the claim carries one.
 */
export async function verifyWorkspace(directory: string): Promise<void> {
  const found = await stat(directory).catch(() => null);
  if (found?.isDirectory() !== true) {
    throw new Error(
      `Workspace directory ${directory} does not exist; set WORKER_WORKSPACE_DIR to the path the execution backend mounts`,
    );
  }
  // A directory for a clone, a file for a linked worktree.
  if ((await stat(join(directory, ".git")).catch(() => null)) === null) {
    throw new Error(
      `Workspace directory ${directory} is not a git checkout; nothing has provisioned the session's repository into it`,
    );
  }
}

/** Non-zero only when the session was left in a state somebody has to resolve. */
export function exitCodeFor(summary: WorkerRunSummary): number {
  return summary.outcome === "failed" || summary.outcome === "lease_lost"
    ? 1
    : 0;
}

if (import.meta.main) {
  process.exitCode = exitCodeFor(await main());
}

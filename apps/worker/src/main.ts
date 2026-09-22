import { stat } from "node:fs/promises";

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
 * costs somebody a turn. The directory is all this worker knows about its
 * workspace: what repository belongs in it, and who puts it there, is still
 * outside the claim contract (94S-206), so a missing mount has to fail here
 * rather than as an unexplained engine spawn error mid-turn.
 */
export async function verifyWorkspace(directory: string): Promise<void> {
  const found = await stat(directory).catch(() => null);
  if (found?.isDirectory() !== true) {
    throw new Error(
      `Workspace directory ${directory} does not exist; set WORKER_WORKSPACE_DIR to the path the execution backend mounts`,
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

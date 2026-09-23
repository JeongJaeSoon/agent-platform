import { readFile } from "node:fs/promises";
import {
  DEFAULT_STATUS_FILE,
  healthStaleSecFromEnv,
  type PassLoopEnvironment,
  type PassStatus,
} from "./loop.ts";

/**
 * Healthy only while a pass has succeeded within `staleMs`. A loop stuck in
 * one pass, or failing every pass, stops refreshing `lastSuccessAt` and reads
 * unhealthy even though the process is alive (94S-320).
 */
export function judgeHealth(
  status: PassStatus | null,
  now: Date,
  staleMs: number,
): { healthy: boolean; reason: string } {
  if (status === null) return { healthy: false, reason: "no status file" };
  if (status.lastSuccessAt === null) {
    return {
      healthy: false,
      reason: `no pass has succeeded since ${status.loopStartedAt}`,
    };
  }
  const ageMs = now.getTime() - Date.parse(status.lastSuccessAt);
  if (ageMs > staleMs) {
    return {
      healthy: false,
      reason: `last successful pass ${Math.round(ageMs / 1000)}s ago (${status.consecutiveFailures} failed since: ${status.lastFailureReason ?? "none finished"})`,
    };
  }
  return {
    healthy: true,
    reason: `last successful pass ${Math.round(ageMs / 1000)}s ago`,
  };
}

export async function readStatus(path: string): Promise<PassStatus | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PassStatus;
  } catch {
    return null;
  }
}

export async function checkHealth(
  environment: PassLoopEnvironment,
  now = new Date(),
): Promise<{ healthy: boolean; reason: string }> {
  const staleMs = healthStaleSecFromEnv(environment) * 1000;
  const status = await readStatus(
    environment.RECONCILER_STATUS_FILE ?? DEFAULT_STATUS_FILE,
  );
  return judgeHealth(status, now, staleMs);
}

if (import.meta.main) {
  const { healthy, reason } = await checkHealth(process.env);
  (healthy ? console.log : console.error)(reason);
  process.exitCode = healthy ? 0 : 1;
}

import { readFile } from "node:fs/promises";
import {
  DEFAULT_STATUS_FILE,
  healthStaleSecFromEnv,
  type PassLoopEnvironment,
  type PassStatus,
} from "./loop.ts";

/**
 * Healthy only while the last finished pass succeeded, no pass is running
 * past its deadline, and a pass has succeeded within `staleMs` (94S-320).
 * The first two catch a pass that hangs or fails right after a success; the
 * last catches a loop that stops finishing passes at all, however it stalls.
 * One failed pass is enough: Docker only calls the service unhealthy after
 * the healthcheck's retries, by which time the next pass has run.
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
  if (
    status.passDeadlineAt !== null &&
    now.getTime() > Date.parse(status.passDeadlineAt)
  ) {
    return {
      healthy: false,
      reason: `a pass has been running past its deadline of ${status.passDeadlineAt}`,
    };
  }
  if (status.consecutiveFailures > 0) {
    return {
      healthy: false,
      reason: `${status.consecutiveFailures} failed pass(es) since the last success: ${status.lastFailureReason}`,
    };
  }
  const ageMs = now.getTime() - Date.parse(status.lastSuccessAt);
  if (ageMs > staleMs) {
    return {
      healthy: false,
      reason: `last successful pass ${Math.round(ageMs / 1000)}s ago`,
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

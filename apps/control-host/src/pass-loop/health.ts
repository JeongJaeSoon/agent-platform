import { readFile } from "node:fs/promises";
import {
  healthStaleSecFromEnv,
  type PassLoopEnvironment,
  type PassLoopRole,
  type PassStatus,
  statusFileFromEnv,
} from "./loop.ts";

/**
 * Healthy only while the last finished pass did not fail, no pass is running
 * past its deadline, and a pass has completed within `staleMs` (94S-320).
 * The first two catch a pass that hangs or fails right after a success; the
 * last catches a loop that stops finishing passes at all, however it stalls.
 * One failed pass is enough: Docker only calls the service unhealthy after
 * the healthcheck's retries, by which time the next pass has run. A skipped
 * pass refreshes nothing, so a loop that only skips goes stale. A degraded
 * pass completed (94S-368): it keeps the loop healthy, and the reason says
 * it was degraded.
 */
export function judgeHealth(
  status: PassStatus | null,
  now: Date,
  staleMs: number,
): { healthy: boolean; reason: string } {
  if (status === null) return { healthy: false, reason: "no status file" };
  const success = timeOf(status.lastSuccessAt);
  const degraded = timeOf(status.lastDegradedAt);
  if (success === null && degraded === null) {
    return {
      healthy: false,
      reason: `no pass has completed since ${status.loopStartedAt}`,
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
      reason: `${status.consecutiveFailures} failed pass(es) since the last completed one: ${status.lastFailureReason}`,
    };
  }
  const completed = Math.max(success ?? 0, degraded ?? 0);
  const ageSec = Math.round((now.getTime() - completed) / 1000);
  const reason =
    completed === degraded && completed !== success
      ? `last pass ${ageSec}s ago completed degraded`
      : `last successful pass ${ageSec}s ago`;
  return { healthy: now.getTime() - completed <= staleMs, reason };
}

function timeOf(iso: string | null): number | null {
  return iso === null ? null : Date.parse(iso);
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
  role: PassLoopRole,
  now = new Date(),
): Promise<{ healthy: boolean; reason: string }> {
  const staleMs = healthStaleSecFromEnv(environment, role) * 1000;
  const status = await readStatus(statusFileFromEnv(environment, role));
  return judgeHealth(status, now, staleMs);
}

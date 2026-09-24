import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_LEASE_SAFETY_MARGIN_MS,
} from "@agent-platform/contracts";
import { DEFAULT_LEASE_TTL_MS } from "@agent-platform/platform";

// HEARTBEAT_TTL_SEC is read here and nowhere else (94S-132). Every lease the
// gateway grants carries its own deadline into the database — the attempt's
// and the `workers` row's — and the reconciler judges those deadlines, so a
// second process never needs its own copy of the value. That is why a
// malformed value stops the API instead of quietly becoming the default: a
// silently different TTL is exactly the divergence this file closes.
// A day: far past any sane lease, and small enough that every deadline
// computed from it stays a finite timestamp.
export const MAX_HEARTBEAT_TTL_SEC = 86_400;

// A worker gives its lease up this long before it runs out, and beats this
// often; a lease no longer than both is lost at or near the first beat
// (94S-389). No launcher sets the worker's own values, so its defaults are
// the ones every worker runs with.
export const MIN_HEARTBEAT_TTL_SEC =
  (WORKER_LEASE_SAFETY_MARGIN_MS + WORKER_HEARTBEAT_INTERVAL_MS) / 1000;

export function heartbeatTtlMsFromEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  const seconds = Number(value);
  if (
    value.trim() === "" ||
    !Number.isFinite(seconds) ||
    seconds <= MIN_HEARTBEAT_TTL_SEC ||
    seconds > MAX_HEARTBEAT_TTL_SEC
  ) {
    throw new Error(
      `HEARTBEAT_TTL_SEC must be a number of seconds above ${MIN_HEARTBEAT_TTL_SEC} (the worker's lease safety margin plus its heartbeat interval) and up to ${MAX_HEARTBEAT_TTL_SEC}, got ${JSON.stringify(value)}`,
    );
  }
  return seconds * 1000;
}

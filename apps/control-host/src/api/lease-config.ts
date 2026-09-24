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

export function heartbeatTtlMsFromEnv(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  const seconds = Number(value);
  if (
    value.trim() === "" ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > MAX_HEARTBEAT_TTL_SEC
  ) {
    throw new Error(
      `HEARTBEAT_TTL_SEC must be a positive number of seconds up to ${MAX_HEARTBEAT_TTL_SEC}, got ${JSON.stringify(value)}`,
    );
  }
  return seconds * 1000;
}

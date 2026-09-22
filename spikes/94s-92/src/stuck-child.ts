import { deadline } from "./deadline.ts";
import { groupMembers, killGroup } from "./process-group.ts";

/** How long one signal is given to take effect before the next one. */
export const SIGNAL_GRACE_MS = 2_000;

/**
 * What the watchdog must keep in hand when it fires.
 *
 * Derived, not chosen: a margin smaller than the cleanup it guards would let
 * bun's own test timeout cut off the diagnosis — which is the one thing the
 * watchdog exists to prevent. The slack covers `pgrep` and process bookkeeping.
 */
export const WATCHDOG_MARGIN_MS = 2 * SIGNAL_GRACE_MS + 2_000;

export type StuckChild = {
  readonly pid?: number | undefined;
};

/**
 * Takes down a child that would not settle, and reports what it took.
 *
 * The child leads its own process group (see `startChild`), so both signals go
 * to the group rather than to the one pid: everything the Agent SDK spawned
 * below it goes with it, and nothing can fork its way out between snapshots.
 */
export async function reapStuckChild(
  child: StuckChild,
  settled: Promise<unknown>,
): Promise<string[]> {
  const pgid = child.pid;
  if (pgid === undefined) return ["no pid: nothing to reap"];

  const notes = [`group before: ${groupMembers(pgid).join(", ") || "empty"}`];

  killGroup(pgid, "SIGTERM");
  const grace = deadline(SIGNAL_GRACE_MS);
  await Promise.race([settled, grace.expired]);
  grace.cancel();

  killGroup(pgid, "SIGKILL");
  const reap = deadline(SIGNAL_GRACE_MS);
  const settledAfterKill = await Promise.race([
    settled.then(() => true),
    reap.expired.then(() => false),
  ]);
  reap.cancel();

  notes.push(
    `after SIGKILL: settled=${settledAfterKill} group=${groupMembers(pgid).join(", ") || "empty"}`,
  );
  return notes;
}

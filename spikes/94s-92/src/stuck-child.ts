import { deadline } from "./deadline.ts";
import { isAlive, reapDescendants } from "./process-tree.ts";

/** How long one signal is given to take effect before the next one. */
export const SIGNAL_GRACE_MS = 2_000;
export const REAP_SWEEPS = 5;
export const REAP_SWEEP_MS = 25;

/**
 * What the watchdog must keep in hand when it fires.
 *
 * Derived, not chosen: a margin smaller than the cleanup it guards would let
 * bun's own test timeout cut off the diagnosis — which is the one thing the
 * watchdog exists to prevent. The slack covers `pgrep` and process bookkeeping.
 */
export const WATCHDOG_MARGIN_MS =
  REAP_SWEEPS * REAP_SWEEP_MS + 2 * SIGNAL_GRACE_MS + 2_000;

export type StuckChild = {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): void;
};

/**
 * Takes down a child that would not settle, and reports what it took.
 *
 * Descendants go first, while the child is still alive to point at them: the
 * Agent SDK spawns the Claude CLI below it, and once the child is gone its
 * children are reparented and `pgrep -P` can no longer reach them. A survivor
 * does not hold the child's stdout open — the SDK gives it its own pipes — but
 * it does keep talking to the fake API and to LocalStack while the next test is
 * already using them.
 */
export async function reapStuckChild(
  child: StuckChild,
  settled: Promise<unknown>,
): Promise<string[]> {
  const notes: string[] = [];

  const reaped =
    child.pid === undefined
      ? []
      : await reapDescendants(child.pid, REAP_SWEEPS);
  notes.push(`descendants reaped: ${reaped.join(", ") || "none"}`);

  child.kill("SIGTERM");
  const grace = deadline(SIGNAL_GRACE_MS);
  await Promise.race([settled, grace.expired]);
  grace.cancel();

  child.kill("SIGKILL");
  const reap = deadline(SIGNAL_GRACE_MS);
  const settledAfterKill = await Promise.race([
    settled.then(() => true),
    reap.expired.then(() => false),
  ]);
  reap.cancel();
  notes.push(
    `after SIGKILL: settled=${settledAfterKill} alive=${reaped.filter(isAlive).join(", ") || "none"}`,
  );
  return notes;
}

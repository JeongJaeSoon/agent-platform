import {
  type PointerRuntime,
  selectWorkerImage,
  type WorkerImageRuntimes,
} from "./worker-images.ts";

/** A session holding an uncollected checkpoint, as the database reads it. */
export type UpgradeSession = {
  readonly sessionId: string;
  readonly pointer: PointerRuntime;
};

export type UnresumableReason =
  /** Its pointer's runtime runs on neither target image. */
  | "no_image"
  /** Its pointer was committed before runtimes were recorded. */
  | "unrecorded";

export type AffectedSession = {
  readonly sessionId: string;
  readonly reason: UnresumableReason;
};

export type UpgradeAssessment = {
  readonly verdict: "proceed" | "refused";
  readonly affected: readonly AffectedSession[];
  readonly approved: readonly string[];
  readonly reason?: string;
};

/**
 * Whether a release may replace the deployed worker image. It goes ahead
 * when the worker image stays, or when it moves within the support window
 * (the target's previous image is the deployed one) and every session it
 * leaves with no image to resume on was approved, exactly: one more or one
 * fewer means the list the operator read is not the one that would break.
 */
export function assessUpgrade(input: {
  readonly deployedWorker: string;
  readonly targetWorker: string;
  readonly targetPreviousWorker: string | null;
  readonly runtimes: WorkerImageRuntimes;
  readonly sessions: readonly UpgradeSession[];
  readonly approved: readonly string[];
}): UpgradeAssessment {
  const approved = [...new Set(input.approved)].sort();
  if (input.targetWorker === input.deployedWorker) {
    return { verdict: "proceed", affected: [], approved: [] };
  }
  const affected = input.sessions
    .flatMap((session): AffectedSession[] => {
      const reason = unresumable(session, input.runtimes);
      return reason === null ? [] : [{ sessionId: session.sessionId, reason }];
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  // Workers on the deployed image keep sealing checkpoints after this check
  // runs, so no list approved now covers them: no approval passes this.
  if (input.targetPreviousWorker !== input.deployedWorker) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `the target's previous worker image (${input.targetPreviousWorker ?? "none"}) is not the deployed one (${input.deployedWorker}): workers running it would keep sealing checkpoints neither target image restores`,
    };
  }
  if (affected.length === 0) {
    return { verdict: "proceed", affected, approved: [] };
  }
  const ids = affected.map((session) => session.sessionId);
  const missing = ids.filter((id) => !approved.includes(id));
  const extra = approved.filter((id) => !ids.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `${ids.length} session(s) could resume on neither target image; approve exactly this list in upgrade.approvedSessions — not approved: ${missing.join(" ") || "none"}; no longer affected: ${extra.join(" ") || "none"}`,
    };
  }
  return { verdict: "proceed", affected, approved };
}

// A launch runs an unrecorded pointer on the newest image and lets the
// restore judge it; before an upgrade that judgement is not available, so
// it counts as affected.
function unresumable(
  { pointer }: UpgradeSession,
  runtimes: WorkerImageRuntimes,
): UnresumableReason | null {
  if (pointer.kind === "unrecorded") return "unrecorded";
  const selection = selectWorkerImage(pointer, [
    { image: "current", runtime: runtimes.current },
    ...(runtimes.previous === null
      ? []
      : [{ image: "previous", runtime: runtimes.previous }]),
  ]);
  return selection.kind === "none" ? "no_image" : null;
}

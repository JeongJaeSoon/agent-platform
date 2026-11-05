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
 * An upgrade that replaces no worker image, `because` naming why. Approvals
 * stay in the release values, so a stale list must be cleared before any
 * upgrade: carried to a later one it could approve sessions the operator
 * never read.
 */
export function assessNothingReplaced(
  approvedSessions: readonly string[],
  because: string,
): UpgradeAssessment {
  const approved = [...new Set(approvedSessions)].sort();
  return approved.length === 0
    ? { verdict: "proceed", affected: [], approved: [] }
    : {
        verdict: "refused",
        affected: [],
        approved,
        reason: `${because}, so upgrade.approvedSessions must be empty — no longer affected: ${approved.join(" ")}`,
      };
}

/**
 * Whether a release may replace the deployed worker image, or drop or
 * replace the previous one. It goes ahead when both stay and nothing is
 * approved, or when every session it leaves with no image to resume on was
 * approved, exactly: one more or one fewer means the list the operator read
 * is not the one that would break. A moved worker image must also stay within
 * the support window (the target's previous image is the deployed one).
 */
export function assessUpgrade(input: {
  readonly deployedWorker: string;
  /** The previous image the cluster runs now; null when it has none. */
  readonly deployedPreviousWorker?: string | null;
  readonly targetWorker: string;
  readonly targetPreviousWorker: string | null;
  readonly runtimes: WorkerImageRuntimes;
  readonly sessions: readonly UpgradeSession[];
  readonly approved: readonly string[];
}): UpgradeAssessment {
  const sameWorker = input.targetWorker === input.deployedWorker;
  // The current image stays, but a previous image the cluster resumes
  // sessions on is dropped or replaced: what was sealed on it may now have
  // no image, so the sessions are compared like those of a replaced image.
  const previousLost =
    sameWorker &&
    (input.deployedPreviousWorker ?? null) !== null &&
    input.deployedPreviousWorker !== input.targetPreviousWorker;
  if (sameWorker && !previousLost) {
    return assessNothingReplaced(
      input.approved,
      "the worker image does not change",
    );
  }
  const approved = [...new Set(input.approved)].sort();
  const affected = input.sessions
    .flatMap((session): AffectedSession[] => {
      const reason = unresumable(session, input.runtimes);
      return reason === null ? [] : [{ sessionId: session.sessionId, reason }];
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  // Workers on the deployed image keep sealing checkpoints after this check
  // runs, so no list approved now covers them: no approval passes this. A
  // kept current image seals nothing the target cannot restore.
  if (!sameWorker && input.targetPreviousWorker !== input.deployedWorker) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `the target's previous worker image (${input.targetPreviousWorker ?? "none"}) is not the deployed one (${input.deployedWorker}): workers running it would keep sealing checkpoints neither target image restores`,
    };
  }
  const ids = affected.map((session) => session.sessionId);
  const missing = ids.filter((id) => !approved.includes(id));
  const extra = approved.filter((id) => !ids.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    return {
      verdict: "refused",
      affected,
      approved,
      reason: `${ids.length} session(s) could resume on neither target image${previousLost ? ` (the worker image stays, but the deployed previous image ${input.deployedPreviousWorker} is not the target's ${input.targetPreviousWorker ?? "none"})` : ""}; approve exactly this list in upgrade.approvedSessions${ids.length === 0 ? " (empty)" : ""} — not approved: ${missing.join(" ") || "none"}; no longer affected: ${extra.join(" ") || "none"}`,
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

import type { PushRequestState } from "@werft-ai/contracts";
import type { PushSource } from "./push-request-service.ts";

export type PushApprovabilitySession = {
  id: string;
  checkpointRevision: number | null;
};

export type PushApprovabilityRequest = {
  state: PushRequestState;
  checkpointRevision: number;
  gitCommit: string;
};

export type PushUnapprovableReason = "not_requested" | "checkpoint_moved";

export type PushApprovabilityVerdict =
  | { approvable: true }
  | { approvable: false; reason: PushUnapprovableReason };

/**
 * Whether an approval of `request` would pass the server's decision check
 * (push-requests.ts decide, push-request-service.ts decide), judged the same
 * way and never stricter: the canonical rule for every surface that shows
 * a push as awaiting approval.
 *
 * Without a `source` (the slack role holds no checkpoint store) a moved
 * revision counts as approvable: the commit is unknown there, and showing
 * a push as approvable that the server would refuse costs less than hiding
 * one it would take.
 */
export async function pushApprovability(
  session: PushApprovabilitySession,
  request: PushApprovabilityRequest,
  source?: PushSource,
): Promise<PushApprovabilityVerdict> {
  if (request.state !== "requested") {
    return { approvable: false, reason: "not_requested" };
  }
  if (session.checkpointRevision === request.checkpointRevision) {
    return { approvable: true };
  }
  if (source === undefined) return { approvable: true };
  // The approval service reads the manifest the same way and, unless it is
  // ready, leaves only the exact-revision rule standing.
  const latest = await source.readPushSource(session.id).catch(() => null);
  if (
    latest?.status === "ready" &&
    latest.revision === session.checkpointRevision &&
    latest.gitCommit === request.gitCommit
  ) {
    return { approvable: true };
  }
  return { approvable: false, reason: "checkpoint_moved" };
}

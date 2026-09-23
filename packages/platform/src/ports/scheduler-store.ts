import type { ExecutionBackend as ExecutionBackendKind } from "@agent-platform/contracts";
import type {
  ExecutionObservation,
  ExecutionRef,
  LaunchCredentialState,
  LaunchIntent,
} from "./execution-backend.ts";

/**
 * Why a resource that exists is torn down and built again.
 * `credential_mismatch`: it holds a bootstrap credential the registry has
 * rotated past, so it can never bind (94S-231).
 */
export type ReplaceReason =
  | "credential_mismatch"
  | "nonce_expired"
  | "stale_isolation";

export type SchedulerDemand = {
  /** Reserved launch slots: rows that have not given their slot back. */
  activeExecutionCount: number;
  /** Unassigned, admission-active sessions with no open launch. */
  eligibleSessionIds: string[];
};

export type ReserveLaunchInput = {
  backend: ExecutionBackendKind;
  now: Date;
  sessionId: string;
  /**
   * Global cap on reserved launch slots, enforced inside the reservation
   * transaction so concurrent scheduler passes cannot both take the last slot.
   */
  slotLimit: number;
};

/**
 * What the registry durably holds. Image and resources are host
 * configuration, so the scheduler adds them when it turns this into a
 * `LaunchIntent`; a restarted host relaunches with its current settings.
 */
export type StoredLaunchIntent = Omit<
  LaunchIntent,
  "image" | "resources" | "issueBootstrapNonce" | "bootstrapCredentialState"
>;

/**
 * A launch that still holds its slot. Rows written before the intent columns
 * existed carry a null `operationId`: they are inspected and reclaimed like
 * any other, but can never be relaunched.
 */
export type ActiveExecution = Omit<StoredLaunchIntent, "operationId"> & {
  backend: ExecutionBackendKind;
  operationId: string | null;
  /**
   * `terminated` is the kill outbox: a terminate command or the lease-expiry
   * reconciler asked for this generation to go, and the pass tears it down
   * before anything else. The row keeps its slot until the resource is
   * confirmed gone.
   */
  desiredState: "running" | "terminated";
  observedState: ExecutionObservation["state"];
  providerRef: string | null;
  /**
   * A worker already traded this launch's nonce for a binding. Its resource
   * is not something to re-create: the session belongs to an attempt, and
   * only confirming the execution gone can give either one back.
   */
  claimed: boolean;
  /**
   * When this launch's bootstrap credential stops being accepted, or null
   * while no container has been created for it. Past it and unclaimed, the
   * resource can never bind: the credential it holds is fixed in its
   * environment, so it has to be replaced rather than waited on.
   */
  nonceExpiresAt: Date | null;
  /**
   * `nonceExpiresAt` judged on the storage clock as the rows were listed.
   * The scheduler's own clock never decides this: a replica running ahead
   * would replace a resource whose credential is still good.
   */
  nonceExpired: boolean;
  /**
   * `launchNonceFingerprint` of the stored hash, or null while none is held.
   * What a resource's `credentialFingerprint` label is compared to.
   */
  nonceFingerprint: string | null;
  /**
   * A replacement the scheduler committed to before tearing the resource
   * down, until the one built from the intent is observed up. It survives a
   * teardown that only half happened and a control host that died between
   * the two halves: the next pass finishes it with the same intent instead
   * of reading the stopped resource as an ordinary exit.
   */
  pendingReplacement: ReplaceReason | null;
  /**
   * How many replacements this launch has ever been asked for. Never reset,
   * so a launch whose fresh resource keeps being judged replaceable runs into
   * the scheduler's limit instead of being rebuilt forever.
   */
  replacementCount: number;
};

/**
 * Durable side of the scheduler. Every method is its own transaction so the
 * provider call always happens after the intent is committed.
 */
export interface SchedulerStore {
  /**
   * Serializes whole scheduling passes. Returns a release function, or null
   * when another pass holds the lock, so overlapping runs never reconcile the
   * same rows from different snapshots.
   */
  acquirePassLock(): Promise<(() => Promise<void>) | null>;
  inspectDemand(input: { limit: number }): Promise<SchedulerDemand>;
  /**
   * Commits the launch intent for a session that is still eligible and a slot
   * is free, or returns null when either no longer holds (raced by a claim,
   * another launch, or another scheduler pass).
   */
  reserveLaunch(input: ReserveLaunchInput): Promise<StoredLaunchIntent | null>;
  /**
   * Mints this launch's bootstrap nonce, stores only its hash, and returns
   * the plaintext. Refuses a launch that already bound a worker or gave its
   * slot back, so a credential is never issued for a binding that exists.
   */
  issueBootstrapNonce(ref: ExecutionRef): Promise<string>;
  /**
   * Shuts this launch's bootstrap door for good and says whether it was still
   * open: true only when the launch was unclaimed, still held its slot, and
   * its nonce had expired. Deciding and closing in one write is what makes it
   * safe to tear the resource down — a claim that commits either side of it
   * loses or wins outright, never both.
   */
  revokeBootstrapNonce(ref: ExecutionRef): Promise<boolean>;
  /**
   * Records, before anything is torn down, that this launch is to be rebuilt
   * from its stored intent, counts the request, and shuts the launch's
   * bootstrap door in the same write — the resource about to go must not
   * bind a worker between here and the teardown, and the one built next
   * gets a credential of its own. Returns the new count, or null when the
   * launch has bound a worker, given its slot back, or been asked since the
   * rows were read (`expectedCount` no longer matches): there is then
   * nothing to rebuild from this snapshot, and the caller must not tear
   * down. The count check is what stops a pass that lost its lock — a
   * dropped lock connection — from tearing down what a later pass built.
   *
   * `expectedNonceFingerprint`, when given, fences the write on the
   * credential too: the launch must still accept exactly that fingerprint
   * (`launchNonceFingerprint` of its stored hash; null for no credential).
   * `ensureExecution` on another pass rebuilds a resource with a fresh
   * credential without touching the count, so the count alone would let a
   * stale judgement — of any reason — shut the door on that fresh
   * credential (94S-231). The scheduler always passes it; leaving it out
   * fences on the count alone.
   */
  requestReplacement(
    ref: ExecutionRef,
    reason: ReplaceReason,
    expectedCount: number,
    expectedNonceFingerprint?: string | null,
  ): Promise<number | null>;
  /**
   * The replacement landed: the resource built from the intent is up. Clears
   * the pending reason and keeps the count. An operator who wants an
   * exhausted launch retried resets the count alone: clearing the reason as
   * well would turn its stopped resource back into an ordinary exit.
   */
  settleReplacement(ref: ExecutionRef): Promise<void>;
  /**
   * Which credential this launch accepts right now, read without changing
   * anything: the fingerprint of the stored hash while the launch is open,
   * `claimed` once a worker has bound, and no fingerprint while it holds no
   * credential. Rejects a launch that is unknown or gave its slot back, the
   * same way `issueBootstrapNonce` does: its resource is an orphan, not
   * something to replace.
   */
  bootstrapCredentialState(ref: ExecutionRef): Promise<LaunchCredentialState>;
  /** Open launches for `backend` only; other backends' rows are theirs. */
  listActiveExecutions(
    backend: ExecutionBackendKind,
  ): Promise<ActiveExecution[]>;
  /**
   * The subset of `refs` that have a matching *open* launch. A launch that
   * already gave its slot back no longer owns its resource, so the resource
   * is reclaimed as an orphan if it still exists.
   */
  filterKnown(
    refs: ExecutionRef[],
    backend: ExecutionBackendKind,
  ): Promise<ExecutionRef[]>;
  recordObservation(
    ref: ExecutionRef,
    observation: ExecutionObservation,
  ): Promise<void>;
  /**
   * The provider resource is gone for good: the one place a launch slot and
   * its session are handed back. Idempotent, however many passes see it.
   * Refused, changing nothing, while an unclaimed launch has a replacement
   * pending: its resource being gone is the rebuild in progress, not an
   * exit.
   */
  confirmExecutionGone(executionId: string, now: Date): Promise<void>;
  /**
   * The row's kill intent as it stands now, not as the pass's snapshot had
   * it. A terminate can commit while the pass is out at the provider, and
   * the pass must not re-create a resource that was just asked to go.
   */
  desiredStateOf(
    ref: ExecutionRef,
  ): Promise<ActiveExecution["desiredState"] | null>;
  /**
   * Terminate receipts still `accepted` after `deadlineMs` become `unknown`:
   * the caller is told the kill was not observed in time. The execution row
   * keeps its kill intent, so reconciliation goes on and a later
   * confirmation still settles the receipt. Returns the receipts flipped.
   */
  markOverdueTerminations(input: {
    now: Date;
    deadlineMs: number;
  }): Promise<number>;

  /**
   * The subset of `sessionIds` whose workspace must be kept: a session row
   * that has not reached a terminal admission state — a paused or
   * recovery-required session is resumed into the same workspace — or one
   * whose launch still holds its slot. An id with no row at all is not
   * retained: nothing can come back to it.
   *
   * Ids the store cannot judge come back retained, so a workspace labelled
   * with something that is not a session id is left alone rather than reaped.
   */
  filterRetainedSessions(sessionIds: string[]): Promise<string[]>;
}

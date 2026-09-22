import type { ExecutionBackend as ExecutionBackendKind } from "@agent-platform/contracts";
import type {
  ExecutionObservation,
  ExecutionRef,
  LaunchIntent,
} from "./execution-backend.ts";

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
  "image" | "resources" | "issueBootstrapNonce"
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
  issueBootstrapNonce(ref: ExecutionRef, now: Date): Promise<string>;
  /**
   * Shuts this launch's bootstrap door for good and says whether it was still
   * open: true only when the launch was unclaimed, still held its slot, and
   * its nonce had expired. Deciding and closing in one write is what makes it
   * safe to tear the resource down — a claim that commits either side of it
   * loses or wins outright, never both.
   */
  revokeBootstrapNonce(ref: ExecutionRef, now: Date): Promise<boolean>;
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
}

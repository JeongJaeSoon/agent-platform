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
  observedState: ExecutionObservation["state"];
  providerRef: string | null;
  /**
   * A worker already traded this launch's nonce for a binding. Its resource
   * is not something to re-create: the session belongs to an attempt, and
   * only confirming the execution gone can give either one back.
   */
  claimed: boolean;
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
}

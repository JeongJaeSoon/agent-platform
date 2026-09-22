import type { ExecutionBackend as ExecutionBackendKind } from "@agent-platform/contracts";
import type {
  ExecutionObservation,
  ExecutionRef,
  LaunchIntent,
} from "./execution-backend.ts";

export type SchedulerDemand = {
  /** Live executions: desired running and not yet observed terminated. */
  activeExecutionCount: number;
  /** Unassigned, admission-active sessions with no live execution. */
  eligibleSessionIds: string[];
};

export type ReserveLaunchInput = {
  backend: ExecutionBackendKind;
  now: Date;
  sessionId: string;
  /**
   * Global cap on live executions, enforced inside the reservation
   * transaction so concurrent scheduler passes cannot both take the last slot.
   */
  slotLimit: number;
};

/**
 * What the `executions` row durably holds. Image and resources are host
 * configuration, so the scheduler adds them when it turns this into a
 * `LaunchIntent`; a restarted host relaunches with its current settings.
 */
export type StoredLaunchIntent = Omit<LaunchIntent, "image" | "resources">;

export type ActiveExecution = StoredLaunchIntent & {
  observedState: ExecutionObservation["state"];
  providerRef: string | null;
};

/**
 * Durable side of the scheduler. Every method is its own transaction so the
 * provider call always happens after the intent is committed.
 */
export interface SchedulerStore {
  inspectDemand(input: { limit: number }): Promise<SchedulerDemand>;
  /**
   * Commits the launch intent for a session that is still eligible and a slot
   * is free, or returns null when either no longer holds (raced by a claim,
   * another launch, or another scheduler pass).
   */
  reserveLaunch(input: ReserveLaunchInput): Promise<StoredLaunchIntent | null>;
  listActiveExecutions(): Promise<ActiveExecution[]>;
  /**
   * The subset of `refs` that have a matching *live* `executions` row. A row
   * already recorded terminated no longer owns its resource, so the resource
   * is reclaimed as an orphan if it still exists.
   */
  filterKnown(refs: ExecutionRef[]): Promise<ExecutionRef[]>;
  recordObservation(
    ref: ExecutionRef,
    observation: ExecutionObservation,
  ): Promise<void>;
}

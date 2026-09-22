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
   * Commits the launch intent for a session that is still eligible, or
   * returns null when it no longer is (raced by a claim or another launch).
   */
  reserveLaunch(input: ReserveLaunchInput): Promise<StoredLaunchIntent | null>;
  listActiveExecutions(): Promise<ActiveExecution[]>;
  /** The subset of `refs` that have a matching `executions` row. */
  filterKnown(refs: ExecutionRef[]): Promise<ExecutionRef[]>;
  recordObservation(
    ref: ExecutionRef,
    observation: ExecutionObservation,
  ): Promise<void>;
}

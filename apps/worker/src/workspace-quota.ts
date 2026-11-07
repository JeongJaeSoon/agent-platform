import type { WorkspaceLimitMode } from "./workspace-limit-mode.ts";
import type { WorkspaceMeasurement } from "./workspace-meter.ts";

export type WorkspaceQuotaLimits = { bytes: number; inodes: number };

export class WorkspaceQuota {
  private baseline: WorkspaceMeasurement | undefined;
  private partial = { bytes: false, inodes: false };

  constructor(
    private readonly limits: WorkspaceQuotaLimits,
    baseline?: WorkspaceMeasurement,
  ) {
    if (baseline?.complete) this.baseline = baseline;
  }

  exceeded(usage: WorkspaceMeasurement, mode: WorkspaceLimitMode): boolean {
    if (this.baseline === undefined) {
      if (usage.complete) this.baseline = usage;
      return false;
    }
    let exceeded = false;
    for (const axis of ["bytes", "inodes"] as const) {
      // A session already over quota must still be able to run cleanup turns.
      const over =
        mode[axis] !== "hard" &&
        usage[axis] > this.limits[axis] &&
        usage[axis] > this.baseline[axis];
      exceeded ||= over && (usage.complete || this.partial[axis]);
      this.partial[axis] = over && !usage.complete;
    }
    return exceeded;
  }
}

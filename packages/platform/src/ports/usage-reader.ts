/** Installation-wide figures, summed across every owner. */
export type InstallationUsage = {
  /** When the database read them; each figure comes from the same statement. */
  readAt: Date;
  executionSlotsUsed: number;
  queuedInputCount: number;
  storageUsedBytes: number;
  /** null until the storage counter row exists. */
  storageUpdatedAt: Date | null;
};

/**
 * One session's spend and the turns behind it, read in one statement so the
 * amount and the counts describe the same moment: a finalize landing between
 * two reads would otherwise pair an old amount with complete counts.
 */
export type SessionUsageRecord = {
  readAt: Date;
  sessionId: string;
  /** `sessions.cost_usd` as the database prints the numeric. */
  costUsd: string;
  reportedTurnCount: number;
  unreportedTurnCount: number;
  openTurnCount: number;
  queuedInputCount: number;
};

export interface UsageReader {
  installationUsage(): Promise<InstallationUsage>;
  /** null when the session is not visible to the owner. */
  sessionUsage(
    ownerId: string,
    sessionId: string,
  ): Promise<SessionUsageRecord | null>;
}

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
  unmetered: boolean;
  /** `sessions.cost_usd` as the database prints the numeric. */
  costUsd: string;
  providerTokens: number;
  reportedTurnCount: number;
  unreportedTurnCount: number;
  openTurnCount: number;
  queuedInputCount: number;
};

/**
 * Whose sessions a summary adds up: every owner's, or the ones one person
 * (a personal key counts as its creator) or one keyless caller started in
 * one owner partition.
 */
export type UsageSummaryFilter =
  | { kind: "installation" }
  | { kind: "user"; ownerId: string; userId: string }
  | { kind: "api_key"; ownerId: string; apiKeyId: string };

/** Sessions created in [since, until), read in one statement. */
export type UsageSummaryRecord = {
  readAt: Date;
  /** `until` as asked, or `readAt` when it was not. */
  until: Date;
  sessionCount: number;
  /** The sum of `sessions.cost_usd` as the database prints the numeric. */
  costUsd: string;
  providerTokens: number;
  /** Ended turns without a cost report plus open turns. */
  incompleteTurnCount: number;
  runSeconds: number;
};

export interface UsageReader {
  installationUsage(): Promise<InstallationUsage>;
  /** null when the session is not visible to the owner. */
  sessionUsage(
    ownerId: string,
    sessionId: string,
  ): Promise<SessionUsageRecord | null>;
  usageSummary(
    filter: UsageSummaryFilter,
    period: { since: Date; until?: Date },
  ): Promise<UsageSummaryRecord>;
}

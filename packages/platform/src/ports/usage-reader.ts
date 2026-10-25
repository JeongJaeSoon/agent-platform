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

/** One UTC day of a series: `UsageSummaryRecord`'s figures for that day. */
export type UsageSeriesBucketRecord = {
  /** YYYY-MM-DD. */
  date: string;
  sessionCount: number;
  costUsd: string;
  providerTokens: number;
  incompleteTurnCount: number;
  /** The floor of the running total minus the floor of the one before. */
  runSeconds: number;
};

/** Every UTC day [since, until) touches, read in one statement. */
export type UsageSeriesRecord = {
  readAt: Date;
  until: Date;
  buckets: UsageSeriesBucketRecord[];
};

/**
 * One tool name's calls among tool_use events created in the period. A call
 * is timed only when its result is paired and both events carry a time.
 */
export type UsageToolRecord = {
  name: string;
  calls: number;
  failed: number;
  totalMs: number;
  /** 0 when no call of the tool was timed. */
  medianMs: number;
  maxMs: number;
};

export type UsageToolsFilter = {
  period: { since: Date; until?: Date };
  /** Only sessions pinned to a release of this agent. */
  agentId?: string;
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
  usageSeries(
    filter: UsageSummaryFilter,
    period: { since: Date; until?: Date },
  ): Promise<UsageSeriesRecord>;
  /** The most-called tools first, at most `limit` of them. */
  usageTools(
    filter: UsageSummaryFilter,
    tools: UsageToolsFilter,
    limit: number,
  ): Promise<UsageToolRecord[]>;
}

/** One agent's turn in a profile rollout (design 2.3). */
export type RolloutItemRef = {
  rolloutId: string;
  agentId: string;
  generation: number;
};

/** An item this replica holds the lease of. */
export type ClaimedRolloutItem = RolloutItemRef & {
  /** Unique to the claim call; only its holder may write the result. */
  claim: string;
  workspaceId: string;
  targetProfileId: string;
  /** The rollout's actor: the person who made the profile version. */
  actorUserId: string | null;
};

export type RolloutItemResult =
  | { status: "applied" | "superseded" }
  | { status: "failed"; reasonCode: string };

/** A profile row as a rollout judges it. */
export type RolloutProfile = {
  id: string;
  version: number;
  definition: Record<string, unknown>;
};

/** The profile an agent runs and the newest of the same lineage. */
export type RolloutInspection = {
  /** Null when the agent is gone. */
  tracking: "follow" | "pinned" | null;
  /** False when the two profiles are not versions of one profile. */
  sameLineage: boolean;
  latest: RolloutProfile | null;
  active: RolloutProfile | null;
};

export type BackfillReport = {
  dryRun: boolean;
  /** Following agents on a profile whose form is not the lineage's latest. */
  pinned: string[];
  /** Fixed-model agents whose model is their profile's default. */
  modelFollowsProfile: string[];
};

export interface ProfileRolloutStore {
  /**
   * Pending items whose lease is free or over, leased to one new claim token.
   * An item claimed too often is failed `retries_exhausted`, never retried.
   */
  claim(input: {
    leaseMs: number;
    limit: number;
  }): Promise<ClaimedRolloutItem[]>;
  /**
   * Writes the result of a claimed item, only while that claim still holds a
   * live lease. False: the lease was lost and nothing was written.
   */
  settle(item: ClaimedRolloutItem, result: RolloutItemResult): Promise<boolean>;
  /** Gives claimed, unfinished items back at once (a stopping replica). */
  abandon(claims: readonly string[]): Promise<number>;
  /** A failed item back to pending: the one way a person resumes it. */
  retry(item: RolloutItemRef): Promise<boolean>;
  /**
   * Puts in the items the insert-time write missed (design 2.3, the sweep).
   * Writes the outbox, so it is run only once the writer is open.
   */
  sweep(): Promise<{ rollouts: number; items: number }>;
  inspect(input: {
    agentId: string;
    targetProfileId: string;
    activeProfileId: string;
  }): Promise<RolloutInspection>;
  /**
   * The one-time fill of `profile_tracking` and `model_source` before the
   * outbox is written. A real run is refused once any rollout exists.
   */
  backfill(input: {
    dryRun: boolean;
  }): Promise<BackfillReport | { refused: "rollouts_exist" }>;
}

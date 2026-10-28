import type { PermissionMode } from "@werft-ai/contracts";
import type { TeamActor } from "./team-store.ts";

/**
 * An installation ceiling as stored. `catalog` rows were imported from
 * `profiles.yaml` under their YAML id; `console` rows are named versions.
 * Nothing changes but `retired_at` and `blocked_at`.
 */
export type InstallationProfileRecord = {
  id: string;
  name: string | null;
  version: number;
  origin: "catalog" | "console";
  /** The profile entry as written, credential references only; parsed again on read. */
  definition: unknown;
  permission_mode: PermissionMode;
  /** `profileFingerprint` when written: a row that no longer hashes to it runs nothing. */
  fingerprint: string;
  /**
   * The repositories the ceiling may run against: the only record of it.
   * Null on a `catalog` row the api role has not yet filled from the
   * `profiles` arrays of repositories.yaml.
   */
  repository_ids: string[] | null;
  previous_id: string | null;
  created_by: string | null;
  created_at: Date;
  retired_at: Date | null;
  retired_by: string | null;
  blocked_at: Date | null;
  blocked_by: string | null;
};

/** One `profiles.yaml` entry to import. */
export type CatalogProfileImport = {
  id: string;
  definition: unknown;
  permission_mode: PermissionMode;
  fingerprint: string;
};

/**
 * `seeded`: the ids put in an empty table. `migrated`: imported rows whose
 * repositories were filled from repositories.yaml, which happens once.
 */
export type CatalogSeedResult = {
  seeded: string[];
  migrated: string[];
};

/** A console ceiling to save as the next version of `name`. */
export type CreateInstallationProfileInput = {
  actor: TeamActor;
  receiptId: string;
  name: string;
  /** What the caller says it replaces: the latest version of `name`, if any. */
  previousId: string | null;
  /** Its `catalogProfileConfigSchema` output, provider copied from the connection. */
  definition: unknown;
  permission_mode: PermissionMode;
  fingerprint: string;
  repository_ids: string[];
  /** Named in the receipt. */
  connectionId: string;
};

export type CreateInstallationProfileResult =
  | { outcome: "created"; record: InstallationProfileRecord }
  | { outcome: "actor_inactive" }
  /** `op_<name>_v<n>` is already a row: an imported id of that shape. */
  | { outcome: "id_taken"; id: string }
  /** `previousId` is not the latest version of `name`, which is `latestId`. */
  | { outcome: "stale_previous"; latestId: string | null }
  /** A first version names a `previousId` that is no row. */
  | { outcome: "unknown_previous" };

export type RetireInstallationProfileResult =
  | { outcome: "retired" | "unchanged"; record: InstallationProfileRecord }
  | { outcome: "not_found" | "actor_inactive" };

export type BlockInstallationProfileResult =
  | { outcome: "changed" | "unchanged"; record: InstallationProfileRecord }
  | { outcome: "not_found" | "actor_inactive" };

export interface InstallationProfileStore {
  listAll(): Promise<InstallationProfileRecord[]>;
  /**
   * One seeder at a time across replicas, in one transaction: while the
   * table is empty, inserts what `entries` reads, so a filled table never
   * reads it; then gives each imported row without repositories its
   * `repositoryIdsOf`.
   */
  seedCatalog(input: {
    entries: () => Promise<CatalogProfileImport[]>;
    repositoryIdsOf: (profileId: string) => string[];
  }): Promise<CatalogSeedResult>;
  /**
   * Saves the next version of `input.name` and its receipt in one
   * transaction, under the import's lock, while the actor is still a live
   * owner.
   */
  create(
    input: CreateInstallationProfileInput,
  ): Promise<CreateInstallationProfileResult>;
  /** Sets `retired_at` once; a second call changes nothing and writes no receipt. */
  retire(input: {
    actor: TeamActor;
    receiptId: string;
    profileId: string;
  }): Promise<RetireInstallationProfileResult>;
  /** Sets (`blocked`) or clears `blocked_at`; one already so changes nothing and writes no receipt. */
  setBlocked(input: {
    actor: TeamActor;
    receiptId: string;
    profileId: string;
    blocked: boolean;
  }): Promise<BlockInstallationProfileResult>;
}

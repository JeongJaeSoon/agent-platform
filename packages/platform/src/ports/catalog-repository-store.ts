import type { ReceiptActor } from "@werft-ai/contracts";

/**
 * A repository that uses the console's GitHub App, as the database holds it
 * (repository-catalog-db.md §1; settings-replace-file-catalog.md §1.1).
 * Removed rows are never listed.
 */
export interface CatalogRepositoryRow {
  id: string;
  github_repository_id: number | null;
  owner: string;
  name: string;
  url: string;
  branch: string;
  /** A seeded row's yaml `profiles`; null otherwise. */
  profiles: string[] | null;
  source: "seed" | "console" | "selection";
  version: number;
  created_at: string;
  updated_at: string;
}

/** A `{ kind: github_app }` entry of repositories.yaml to seed with. */
export interface SeedRepository {
  id: string;
  owner: string;
  name: string;
  url: string;
  branch: string;
  profiles: string[] | null;
}

interface RepositoryWrite {
  workspaceId: string;
  userId: string;
  actor: ReceiptActor;
  requestId: string | null;
  /** The id of the receipt the write leaves, which the response names. */
  receiptId: string;
}

export interface CatalogRepositoryStore {
  listActive(): Promise<CatalogRepositoryRow[]>;
  /**
   * `listActive`, or null while the table has never held a row: the seed
   * has not run yet, so the operator file still decides.
   */
  readCatalog(): Promise<CatalogRepositoryRow[] | null>;
  /**
   * Inserts `entries` only while the table has no row at all, so a restart
   * never brings back what the console removed. Returns the ids inserted.
   */
  seed(input: { entries: () => Promise<SeedRepository[]> }): Promise<string[]>;
  /**
   * The row of that GitHub repository: found by its id (taking the new
   * owner/name and URL after a rename), else by owner/name on a row with no
   * GitHub id yet (filling it in), else inserted as a `selection` row under
   * `base`, numbered `-2`, `-3` past ids ever used or `reserved`. A row of
   * another GitHub repository under that name is `name_held`. Only an
   * insert leaves a receipt.
   */
  resolve(
    input: RepositoryWrite & {
      base: string;
      /** Ids the operator's file holds, which a row may not take. */
      reserved: ReadonlySet<string>;
      githubRepositoryId: number;
      owner: string;
      name: string;
      url: string;
      branch: string;
    },
  ): Promise<
    | {
        outcome: "resolved";
        repository: CatalogRepositoryRow;
        /** False when an earlier row was found: no receipt was written. */
        created: boolean;
        /** Whether the catalog changed: an insert or a rename. */
        changed: boolean;
      }
    | { outcome: "name_held"; id: string }
    | { outcome: "actor_inactive" }
  >;
  setBranch(
    input: RepositoryWrite & { id: string; branch: string; version: number },
  ): Promise<
    | { outcome: "stored"; repository: CatalogRepositoryRow }
    | { outcome: "actor_inactive" | "not_found" | "revision_conflict" }
  >;
  /** Per catalog id, how many agents' active releases name it. */
  agentCounts(): Promise<ReadonlyMap<string, number>>;
}

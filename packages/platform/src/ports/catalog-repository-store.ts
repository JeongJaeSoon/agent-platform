import type { ReceiptActor } from "@werft-ai/contracts";

/**
 * A repository that uses the console's GitHub App, as the database holds it
 * (repository-catalog-db.md §1). Removed rows are never listed.
 */
export interface CatalogRepositoryRow {
  id: string;
  github_repository_id: number | null;
  owner: string;
  name: string;
  url: string;
  branch: string;
  /** A seeded row's yaml `profiles`; null for a console row. */
  profiles: string[] | null;
  source: "seed" | "console";
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
   * Inserts `entries` only while the table has no row at all, so a restart
   * never brings back what the console removed. Returns the ids inserted.
   */
  seed(input: { entries: () => Promise<SeedRepository[]> }): Promise<string[]>;
  add(
    input: RepositoryWrite & {
      /** The id asked for, or the base the store numbers from. */
      id: { exact: string } | { base: string };
      /** Ids the operator's file holds, which a row may not take. */
      reserved: ReadonlySet<string>;
      githubRepositoryId: number;
      owner: string;
      name: string;
      url: string;
      branch: string;
    },
  ): Promise<
    | { outcome: "stored"; repository: CatalogRepositoryRow }
    | { outcome: "actor_inactive" | "already_added" | "id_taken" }
  >;
  setBranch(
    input: RepositoryWrite & { id: string; branch: string; version: number },
  ): Promise<
    | { outcome: "stored"; repository: CatalogRepositoryRow }
    | { outcome: "actor_inactive" | "not_found" | "revision_conflict" }
  >;
  remove(input: RepositoryWrite & { id: string }): Promise<
    | { outcome: "removed" }
    | { outcome: "actor_inactive" | "not_found" }
    | {
        outcome: "in_use";
        /** Profile ceilings and agents whose active release names it. */
        profiles: string[];
        agents: string[];
      }
  >;
}

import type { PermissionMode } from "@werft-ai/contracts";

/**
 * An installation ceiling as stored. `catalog` rows were imported from
 * `profiles.yaml` under their YAML id; `console` rows are named versions.
 * Nothing changes but `retired_at`.
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
  /** Repositories a `console` row may run against; empty for `catalog`. */
  repository_ids: string[];
  previous_id: string | null;
  created_by: string | null;
  created_at: Date;
  retired_at: Date | null;
  retired_by: string | null;
};

/** One `profiles.yaml` entry to import. */
export type CatalogProfileImport = {
  id: string;
  definition: unknown;
  permission_mode: PermissionMode;
  fingerprint: string;
};

/**
 * `conflicts`: ids already present with another definition, or as a console
 * row; never overwritten. `fields` names the top-level keys that differ.
 */
export type CatalogImportResult = {
  inserted: string[];
  conflicts: Array<{
    id: string;
    origin: InstallationProfileRecord["origin"];
    fields: string[];
  }>;
};

export interface InstallationProfileStore {
  listAll(): Promise<InstallationProfileRecord[]>;
  /**
   * Inserts each entry whose id is absent, one importer at a time across
   * replicas. Running it again with the same entries inserts nothing.
   */
  importCatalog(entries: CatalogProfileImport[]): Promise<CatalogImportResult>;
}

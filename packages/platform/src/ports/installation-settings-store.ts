import type {
  CatalogMcpServerConfig,
  CatalogProfileConfig,
  CatalogRepositoryConfig,
  StoredOwnerKind,
} from "../sessions/catalog.ts";

/**
 * The installation's settings as one read (decision
 * settings-replace-file-catalog.md §1): every catalog repository of every
 * kind and every connection and MCP server not disabled, with the values
 * the console stored for them.
 */
export interface InstallationSettings {
  /** `settings_generation` as it was before the rows were read. */
  generation: number;
  connections: ReadonlyArray<{
    id: string;
    provider: CatalogProfileConfig["provider"];
  }>;
  /** In the shape repositories.yaml gives an entry. */
  repositories: ReadonlyArray<{ id: string; repository: CatalogRepositoryConfig }>;
  mcpServers: ReadonlyArray<{ id: string; server: CatalogMcpServerConfig }>;
  /** By `stored` reference (`connection:<id>`, …); absent when none is set. */
  stored: ReadonlyMap<string, string>;
  /** Rows left out because they no longer parse, as `<kind>:<id>`. */
  invalid: readonly string[];
}

/** What an import of the operator's files brings, in the files' shape. */
export interface SettingsImport {
  connections: Readonly<Record<string, CatalogProfileConfig["provider"]>>;
  /** Entries other than `{ kind: github_app }`, which the repository seed brings. */
  repositories: Readonly<Record<string, CatalogRepositoryConfig>>;
  mcpServers: Readonly<Record<string, CatalogMcpServerConfig>>;
}

export interface InstallationSettingsStore {
  /** One snapshot of the rows and the generation they were read at. */
  read(): Promise<InstallationSettings>;
  /** `settings_generation` alone. */
  generation(): Promise<number>;
  /**
   * Inserts each entry whose id is new; an id already held is left as it is
   * and returned in `conflicts` when it holds something else.
   */
  importSettings(entries: SettingsImport): Promise<{
    inserted: string[];
    conflicts: string[];
  }>;
  /**
   * Sets the value behind `stored: <kind>:<id>` under a new
   * `secret_version`. The row it belongs to is not checked here.
   */
  putStoredValue(
    owner: { kind: StoredOwnerKind; id: string },
    value: string,
    updatedBy: string | null,
  ): Promise<void>;
}

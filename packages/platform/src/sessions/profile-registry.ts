import {
  canonicalJson,
  OPT_IN_PERMISSION_MODES,
  type ProfileDerivationPolicy,
  WORKSPACE_PROFILE_POLICY,
} from "@werft-ai/contracts";
import type {
  CatalogProfileImport,
  InstallationProfileRecord,
  InstallationProfileStore,
} from "../ports/installation-profile-store.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  type CatalogMcpServer,
  type CatalogProfileConfig,
  type CatalogProfileView,
  type CatalogRepositoryView,
  type CredentialRef,
  catalogProfileConfigSchema,
  type InstallationProfileEntry,
  type InstallationProfileState,
  profileFingerprint,
  type RuntimeVersions,
  type SessionCatalogConfig,
  sessionCatalogView,
  type WorkspaceProfileRecord,
  type WorkspaceProfiles,
} from "./catalog.ts";
import type { SettingsSnapshot } from "./installation-settings.ts";

// One registry for every profile a process resolves
// (docs/contributing/decisions/profile-db.md §2): the installation ceilings
// in `installation_profiles` and the workspace versions over them, read in
// one pass into one snapshot that `catalog.profiles` serves.

/** A provider an installation ceiling may run against, by connection id. */
export type Connections = Readonly<
  Record<string, CatalogProfileConfig["provider"]>
>;

/**
 * The repositories each imported id may run against, as the `profiles`
 * arrays of repositories.yaml named them: read only to seed and to fill
 * rows from before the database held them.
 */
export function catalogRepositoryIds(
  repositories: Readonly<
    Record<string, { profiles?: readonly string[] | undefined }>
  >,
): (profileId: string) => string[] {
  return (profileId) =>
    Object.entries(repositories)
      .filter(([, repository]) => repository.profiles?.includes(profileId))
      .map(([id]) => id)
      .sort();
}

/** The rows `profiles.yaml` imports as: its ids, its entries as parsed. */
export function catalogImports(
  profiles: SessionCatalogConfig["profiles"],
): CatalogProfileImport[] {
  return Object.entries(profiles).map(([id, definition]) => ({
    id,
    definition,
    permission_mode: definition.permission_mode,
    fingerprint: definitionFingerprint(id, definition),
  }));
}

export function definitionFingerprint(
  id: string,
  definition: CatalogProfileConfig,
): string {
  const view = sessionCatalogView({
    profiles: { [id]: definition },
    repositories: {},
  }).profiles[id];
  if (!view) throw new Error(`profile ${id} has no view`);
  return profileFingerprint(view);
}

export type InstallationSnapshot<P extends CatalogProfileView> = {
  /** What runs: every `usable` and `retired` ceiling. */
  profiles: Record<string, P>;
  /** Every ceiling id this replica knows, whatever its state. */
  installation: ReadonlyMap<string, InstallationProfileEntry>;
};

export type SnapshotSources<P extends CatalogProfileView> = {
  connections: Connections;
  /**
   * What a row with no `repository_ids` yet runs against: the value the api
   * role fills it with, so every replica reads the same pairs before it does.
   */
  repositoryIdsOf: (profileId: string) => string[];
  allowUnattended: boolean;
  runtimeSupported: (profile: CatalogProfileConfig) => boolean;
  /**
   * The profile a definition runs; may throw when a credential does not
   * resolve. `lookup` is the settings read's, when the registry has one.
   */
  materialize: (
    id: string,
    definition: CatalogProfileConfig,
    lookup?: (ref: CredentialRef) => string | undefined,
  ) => P;
};

/**
 * The ceilings `rows` run here; the database is their only record. A row
 * runs nothing when it is blocked, its provider is no connection here, it needs the
 * unattended switch this process has off, no installed runtime serves it,
 * or it no longer parses to its stored fingerprint.
 */
export function installationProfileSnapshot<P extends CatalogProfileView>(
  sources: SnapshotSources<P>,
  rows: readonly InstallationProfileRecord[],
): InstallationSnapshot<P> {
  const connections = new Map<string, string>();
  for (const id of Object.keys(sources.connections).sort()) {
    const key = canonicalJson(sources.connections[id]);
    if (!connections.has(key)) connections.set(key, id);
  }
  const profiles: Record<string, P> = {};
  const installation = new Map<string, InstallationProfileEntry>();
  for (const stored of rows) {
    const row = {
      ...stored,
      repository_ids:
        stored.repository_ids ?? sources.repositoryIdsOf(stored.id),
    };
    const { id } = row;
    const parsed = parsedDefinition(row);
    const definition = storedDefinition(id, row, parsed);
    const entry = (state: InstallationProfileState) => {
      installation.set(id, {
        id,
        origin: row.origin,
        state,
        repository_ids: [...row.repository_ids],
        github_app_repositories: row.github_app_repositories,
        record: row,
        definition: parsed ?? undefined,
        connection_id:
          parsed === null
            ? null
            : (connections.get(canonicalJson(parsed.provider)) ?? null),
      });
    };
    // Before every state a replica decides for itself: a block is the same
    // everywhere, so a claim may fail what it stops.
    if (row.blocked_at !== null) {
      entry("blocked");
      continue;
    }
    if (definition === null) {
      entry("definition_drift");
      continue;
    }
    if (!connections.has(canonicalJson(definition.provider))) {
      entry("connection_missing");
      continue;
    }
    if (
      (OPT_IN_PERMISSION_MODES as readonly string[]).includes(
        definition.permission_mode,
      ) &&
      !sources.allowUnattended
    ) {
      entry("unattended_off");
      continue;
    }
    if (!sources.runtimeSupported(definition)) {
      entry("runtime_unsupported");
      continue;
    }
    let profile: P;
    try {
      profile = sources.materialize(id, definition);
    } catch {
      entry("connection_missing");
      continue;
    }
    profiles[id] = profile;
    entry(row.retired_at !== null ? "retired" : "usable");
  }
  return { profiles, installation };
}

function parsedDefinition(
  row: InstallationProfileRecord,
): CatalogProfileConfig | null {
  const parsed = catalogProfileConfigSchema.safeParse(row.definition);
  return parsed.success ? parsed.data : null;
}

// A row runs only while it parses as written and hashes as it did then.
function storedDefinition(
  id: string,
  row: InstallationProfileRecord,
  parsed: CatalogProfileConfig | null,
): CatalogProfileConfig | null {
  if (parsed === null) return null;
  return definitionFingerprint(id, parsed) === row.fingerprint &&
    parsed.permission_mode === row.permission_mode
    ? parsed
    : null;
}

/**
 * `profiles.yaml` entries as the rows seeding them would be, with the
 * repositories `repositories` names them for.
 */
export function catalogRows(
  profiles: SessionCatalogConfig["profiles"],
  repositories: Parameters<typeof catalogRepositoryIds>[0] = {},
): InstallationProfileRecord[] {
  const repositoryIdsOf = catalogRepositoryIds(repositories);
  return catalogImports(profiles).map((entry) => ({
    ...entry,
    name: null,
    version: 1,
    origin: "catalog",
    repository_ids: repositoryIdsOf(entry.id),
    github_app_repositories: "listed",
    previous_id: null,
    created_by: null,
    created_at: new Date(0),
    retired_at: null,
    retired_by: null,
    blocked_at: null,
    blocked_by: null,
  }));
}

/**
 * `catalog` with the ceilings seeding an empty database from it would give:
 * each profile usable, on the repositories whose `profiles` name it. For a
 * catalog put together in memory instead of read through the registry.
 */
export function withSeededInstallation<
  C extends {
    profiles: Readonly<Record<string, unknown>>;
    repositories: Parameters<typeof catalogRepositoryIds>[0];
  },
>(
  catalog: C,
): C & { installation: ReadonlyMap<string, InstallationProfileEntry> } {
  const repositoryIdsOf = catalogRepositoryIds(catalog.repositories);
  return {
    ...catalog,
    installation: new Map(
      Object.keys(catalog.profiles).map((id) => [
        id,
        {
          id,
          origin: "catalog",
          state: "usable",
          repository_ids: repositoryIdsOf(id),
        },
      ]),
    ),
  };
}

/** Ids among `snapshot` that this replica leaves out, with why. */
export function unrunnableProfiles(
  snapshot: Pick<InstallationSnapshot<CatalogProfileView>, "installation">,
): Array<{ id: string; state: InstallationProfileState }> {
  return [...snapshot.installation.values()]
    .filter(({ state }) => state !== "usable" && state !== "retired")
    .map(({ id, state }) => ({ id, state }));
}

/**
 * The newest read wins and a refresh joins one begun within `maxAgeMs`;
 * a failed read keeps what was read before.
 */
export function latestReads<T>(
  read: () => Promise<T>,
  apply: (value: T) => void,
  now: () => number,
): (maxAgeMs?: number) => Promise<void> {
  let readAt = Number.NEGATIVE_INFINITY;
  let begun = 0;
  let applied = 0;
  let latest: { startedAt: number; done: Promise<void> } | null = null;
  return (maxAgeMs = 0) => {
    const oldest = now() - maxAgeMs;
    if (maxAgeMs > 0 && readAt >= oldest) return Promise.resolve();
    if (latest !== null && latest.startedAt > oldest) return latest.done;
    const startedAt = now();
    begun += 1;
    const order = begun;
    const done = read().then(
      (value) => {
        if (order < applied) return;
        apply(value);
        applied = order;
        readAt = startedAt;
      },
      (error: unknown) => {
        if (latest?.done === done) latest = null;
        throw error;
      },
    );
    latest = { startedAt, done };
    return done;
  };
}

/** The workspace versions and the ceiling snapshot, read together. */
export interface ProfileRegistry<P extends CatalogProfileView>
  extends WorkspaceProfiles {
  readonly profiles: Readonly<Record<string, P>>;
  readonly installation: ReadonlyMap<string, InstallationProfileEntry>;
  /**
   * The installation's settings as last read, or null before the first
   * read or for a registry given none.
   */
  readonly settings: SettingsSnapshot | null;
}

/** The snapshot's sources with the settings' connections and repositories. */
function withSettings<P extends CatalogProfileView>(
  sources: SnapshotSources<P>,
  settings: SettingsSnapshot | null,
): SnapshotSources<P> {
  if (settings === null) return sources;
  return {
    ...sources,
    connections: settings.connections,
    repositoryIdsOf: catalogRepositoryIds(settings.repositories),
    materialize: (id, definition) =>
      sources.materialize(id, definition, settings.lookup),
  };
}

// Kept when nothing in it changed: the catalog's repositories object, which
// claim caches key on, then stays the same object too.
function sameRepositories(
  next: SettingsSnapshot,
  previous: SettingsSnapshot | null,
): SettingsSnapshot {
  if (
    previous === null ||
    canonicalJson(next.repositories) !== canonicalJson(previous.repositories)
  ) {
    return next;
  }
  return { ...next, repositories: previous.repositories };
}

/**
 * Runs no ceiling before its first read: the snapshot holds only the rows
 * `installations` last listed.
 */
export function createProfileRegistry<P extends CatalogProfileView>(deps: {
  workspaces: Pick<WorkspaceProfileStore, "listAll">;
  installations: Pick<InstallationProfileStore, "listAll">;
  /** Absent: the catalog keeps the operator file's connections and repositories. */
  settings?: { read(): Promise<SettingsSnapshot> };
  sources: SnapshotSources<P>;
  now?: () => number;
  policy?: ProfileDerivationPolicy;
}): ProfileRegistry<P> {
  let records: ReadonlyMap<string, WorkspaceProfileRecord> = new Map();
  let snapshot = installationProfileSnapshot(deps.sources, []);
  let settings: SettingsSnapshot | null = null;
  const refresh = latestReads(
    // Settings first: a ceiling read after them never names a connection
    // newer than the ones this read holds.
    async () => {
      const read = (await deps.settings?.read()) ?? null;
      return Promise.all([
        deps.workspaces.listAll(),
        deps.installations.listAll(),
        read,
      ]);
    },
    ([workspaceRows, installationRows, read]) => {
      settings = read === null ? null : sameRepositories(read, settings);
      snapshot = installationProfileSnapshot(
        withSettings(deps.sources, settings),
        installationRows,
      );
      records = new Map(workspaceRows.map((row) => [row.id, row]));
    },
    deps.now ?? Date.now,
  );
  return {
    policy: deps.policy ?? WORKSPACE_PROFILE_POLICY,
    get records() {
      return records;
    },
    get profiles() {
      return snapshot.profiles;
    },
    get installation() {
      return snapshot.installation;
    },
    get settings() {
      return settings;
    },
    refresh,
  };
}

/**
 * The catalog whose profiles are the registry's current snapshot. Read
 * `profiles` each time: a copy of the object keeps the snapshot it was
 * copied at.
 */
export function profileCatalog<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  /** What the catalog holds until the registry first reads the settings. */
  base: {
    repositories: Record<string, R>;
    mcp_servers?: Record<string, CatalogMcpServer> | undefined;
    runtime_versions?: RuntimeVersions;
  },
  registry: ProfileRegistry<P>,
  /**
   * The settings' repositories in the catalog's own shape; absent when the
   * settings' are that shape already.
   */
  repositoriesOf: (settings: SettingsSnapshot) => Record<string, R> = (
    settings,
  ) => settings.repositories as Record<string, R>,
): {
  readonly profiles: Record<string, P>;
  readonly repositories: Record<string, R>;
  readonly mcp_servers?: Record<string, CatalogMcpServer> | undefined;
  readonly installation: ReadonlyMap<string, InstallationProfileEntry>;
  /** The settings generation the catalog was read at; absent before. */
  readonly settings_generation?: number | undefined;
  workspace_profiles: ProfileRegistry<P>;
  runtime_versions?: RuntimeVersions;
} {
  let mappedFrom: SettingsSnapshot["repositories"] | null = null;
  let mapped = base.repositories;
  return {
    get profiles() {
      return registry.profiles as Record<string, P>;
    },
    get installation() {
      return registry.installation;
    },
    get repositories() {
      const settings = registry.settings;
      if (settings === null) return base.repositories;
      if (settings.repositories !== mappedFrom) {
        mapped = repositoriesOf(settings);
        mappedFrom = settings.repositories;
      }
      return mapped;
    },
    get mcp_servers() {
      return registry.settings?.mcp_servers ?? base.mcp_servers;
    },
    get settings_generation() {
      return registry.settings?.generation;
    },
    ...(base.runtime_versions === undefined
      ? {}
      : { runtime_versions: base.runtime_versions }),
    workspace_profiles: registry,
  };
}

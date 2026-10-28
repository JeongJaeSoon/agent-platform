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
  catalogProfileConfigSchema,
  type InstallationProfileEntry,
  type InstallationProfileState,
  profileFingerprint,
  type SessionCatalogConfig,
  sessionCatalogView,
  type WorkspaceProfileRecord,
  type WorkspaceProfiles,
} from "./catalog.ts";

// One registry for every profile a process resolves
// (docs/contributing/decisions/profile-db.md §2): the installation ceilings
// in `installation_profiles` and the workspace versions over them, read in
// one pass into one snapshot that `catalog.profiles` serves.

/** A provider an installation ceiling may run against, by connection id. */
export type Connections = Readonly<
  Record<string, CatalogProfileConfig["provider"]>
>;

/**
 * The connections a replica holds: `connections.yaml` when it exists, else
 * each `profiles.yaml` entry's provider under that profile's id. Never both,
 * so taking a connection out of the file always takes it away.
 */
export function catalogConnections(
  profiles: SessionCatalogConfig["profiles"],
  file: Connections | undefined,
): Connections {
  if (file !== undefined) return file;
  return Object.fromEntries(
    Object.entries(profiles).map(([id, profile]) => [id, profile.provider]),
  );
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

/** The top-level keys two definitions differ in, compared as canonical JSON. */
export function differingDefinitionFields(
  stored: unknown,
  wanted: unknown,
): string[] {
  const a = (stored ?? {}) as Record<string, unknown>;
  const b = (wanted ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => canonicalJson(a[key]) !== canonicalJson(b[key]))
    .sort();
}

function definitionFingerprint(
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
  /** This replica's `profiles.yaml`: its ids resolve from it, not the database. */
  own: SessionCatalogConfig["profiles"];
  connections: Connections;
  allowUnattended: boolean;
  runtimeSupported: (profile: CatalogProfileConfig) => boolean;
  /** The profile a definition runs; may throw when a credential does not resolve. */
  materialize: (id: string, definition: CatalogProfileConfig) => P;
};

/**
 * The ceilings `rows` and this replica's own YAML run here. An id in both
 * runs the YAML value (the expansion stage: the replica's YAML is its
 * record), keeping the row's retirement. A row runs nothing when its
 * provider is no connection here, it needs the unattended switch this
 * process has off, no installed runtime serves it, or it no longer parses
 * to its stored fingerprint.
 */
export function installationProfileSnapshot<P extends CatalogProfileView>(
  sources: SnapshotSources<P>,
  rows: readonly InstallationProfileRecord[],
): InstallationSnapshot<P> {
  const connections = new Set(
    Object.values(sources.connections).map((provider) =>
      canonicalJson(provider),
    ),
  );
  const stored = new Map(rows.map((row) => [row.id, row]));
  const ids = [...new Set([...Object.keys(sources.own), ...stored.keys()])];
  const profiles: Record<string, P> = {};
  const installation = new Map<string, InstallationProfileEntry>();
  for (const id of ids.sort()) {
    const row = stored.get(id);
    const own = Object.hasOwn(sources.own, id) ? sources.own[id] : undefined;
    const origin = own !== undefined ? "catalog" : (row?.origin ?? "catalog");
    const retired = row?.origin === origin && row.retired_at !== null;
    const definition = own ?? storedDefinition(id, row);
    const entry = (state: InstallationProfileState) => {
      installation.set(id, {
        id,
        origin,
        state,
        repository_ids:
          origin === "console" ? [...(row?.repository_ids ?? [])] : [],
      });
    };
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
    entry(retired ? "retired" : "usable");
  }
  return { profiles, installation };
}

// A row runs only while it parses as written and hashes as it did then.
function storedDefinition(
  id: string,
  row: InstallationProfileRecord | undefined,
): CatalogProfileConfig | null {
  if (!row) return null;
  const parsed = catalogProfileConfigSchema.safeParse(row.definition);
  if (!parsed.success) return null;
  return definitionFingerprint(id, parsed.data) === row.fingerprint &&
    parsed.data.permission_mode === row.permission_mode
    ? parsed.data
    : null;
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
}

/**
 * Before its first read the registry runs this replica's own YAML alone, as
 * the YAML-only image did: an operator profile never waits on the database.
 */
export function createProfileRegistry<P extends CatalogProfileView>(deps: {
  workspaces: Pick<WorkspaceProfileStore, "listAll">;
  installations: Pick<InstallationProfileStore, "listAll">;
  sources: SnapshotSources<P>;
  now?: () => number;
  policy?: ProfileDerivationPolicy;
}): ProfileRegistry<P> {
  let records: ReadonlyMap<string, WorkspaceProfileRecord> = new Map();
  let snapshot = installationProfileSnapshot(deps.sources, []);
  const refresh = latestReads(
    () =>
      Promise.all([deps.workspaces.listAll(), deps.installations.listAll()]),
    ([workspaceRows, installationRows]) => {
      snapshot = installationProfileSnapshot(deps.sources, installationRows);
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
  base: {
    repositories: Record<string, R>;
    mcp_servers?: Record<string, CatalogMcpServer>;
  },
  registry: ProfileRegistry<P>,
): {
  readonly profiles: Record<string, P>;
  repositories: Record<string, R>;
  mcp_servers?: Record<string, CatalogMcpServer>;
  readonly installation: ReadonlyMap<string, InstallationProfileEntry>;
  workspace_profiles: ProfileRegistry<P>;
} {
  return {
    get profiles() {
      return registry.profiles as Record<string, P>;
    },
    get installation() {
      return registry.installation;
    },
    repositories: base.repositories,
    ...(base.mcp_servers === undefined
      ? {}
      : { mcp_servers: base.mcp_servers }),
    workspace_profiles: registry,
  };
}

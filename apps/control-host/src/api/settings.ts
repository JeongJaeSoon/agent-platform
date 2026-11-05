import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as schema from "@werft-ai/db";
import {
  createPostgresInstallationProfileStore,
  createPostgresSettingsDocumentStore,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  catalogImports,
  catalogRepositoryIds,
  type InstallationProfileStore,
  parseSeedDocument,
  type SeedDocument,
  type SessionCatalogConfig,
  type SettingsDocument,
  type SettingsDocumentStore,
  type SettingsEntries,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { installedRuntimes } from "./catalog-config.ts";
import {
  dirIsEmpty,
  PLATFORM_FILE,
  readCatalogConfig,
  readConnections,
  readSeedProfiles,
  withoutLegacyRepositories,
} from "./settings-from-dir.ts";

// The operator's settings import and export
// (docs/contributing/decisions/settings-replace-file-catalog.md §5, §6).
// Run where keys.ts runs, against the database: unlike the API's import it
// may bring in env and Secrets Manager references, since whoever reaches
// the database already holds the deployment.
const USAGE = `Usage: bun run apps/control-host/src/api/settings.ts export
       bun run apps/control-host/src/api/settings.ts import --document <file|-> [--dry-run]
       bun run apps/control-host/src/api/settings.ts import --from-dir <dir> [--if-present] [--dry-run]`;

export type SettingsCommand =
  | { command: "export" }
  | {
      command: "import";
      source: { document: string } | { dir: string; ifPresent: boolean };
      dryRun: boolean;
    };

export function parseSettingsCommand(argv: string[]): SettingsCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
  const { positionals, values } = parsed;
  const [command, ...extra] = positionals;
  if (extra.length > 0) throw new Error(USAGE);
  if (command === "export") {
    if (
      values.document !== undefined ||
      values["from-dir"] !== undefined ||
      values["dry-run"] !== undefined ||
      values["if-present"] !== undefined
    ) {
      throw new Error(USAGE);
    }
    return { command };
  }
  if (command !== "import") throw new Error(USAGE);
  const document = values.document;
  const dir = values["from-dir"];
  if ((document === undefined) === (dir === undefined)) {
    throw new Error(`name one of --document or --from-dir\n${USAGE}`);
  }
  const ifPresent = values["if-present"] === true;
  if (ifPresent && dir === undefined) {
    throw new Error(`--if-present goes with --from-dir\n${USAGE}`);
  }
  return {
    command,
    source:
      document !== undefined ? { document } : { dir: dir as string, ifPresent },
    dryRun: values["dry-run"] === true,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      document: { type: "string" },
      "from-dir": { type: "string" },
      "if-present": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

/**
 * The old catalog directory as a settings document: connections.yaml,
 * repositories.yaml and mcp-servers.yaml under their own rules, plus the
 * ceilings of profiles.yaml, which go to the same empty-table seed the API
 * ran.
 */
export async function documentFromDir(dir: string): Promise<{
  document: SettingsDocument;
  profiles: SessionCatalogConfig["profiles"];
  notes: string[];
  skipped: string[];
}> {
  const notes: string[] = [];
  const skipped: string[] = [];
  const config = await readCatalogConfig(dir, notes, skipped);
  const entries: SettingsEntries = {
    connections: { ...(await readConnections(dir)) },
    repositories: config.repositories,
    mcp_servers: config.mcp_servers ?? {},
  };
  const skippedRepositories = notes.length > 0;
  if (await Bun.file(resolve(dir, PLATFORM_FILE)).exists()) {
    notes.push(
      `${PLATFORM_FILE} is not imported: set the master key in PLATFORM_SECRET_KEY`,
    );
  }
  return {
    document: settingsDocumentOf(entries),
    profiles: await readSeedProfiles(dir, config, skippedRepositories),
    notes,
    skipped,
  };
}

/** `-` is stdin: the document reaches a container through `exec -T`. */
async function readDocument(path: string): Promise<unknown> {
  const file = path === "-" ? Bun.stdin : Bun.file(path);
  if (path !== "-" && !(await file.exists())) {
    throw new Error(`${path} is missing`);
  }
  try {
    return JSON.parse(await file.text());
  } catch (error) {
    throw new Error(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type Output = { out: (line: string) => void; err: (line: string) => void };

type ProfileSeedReport = {
  seed: string[];
  fill: string[];
  unfilled: string[];
};

async function seedProfiles(
  store: Pick<InstallationProfileStore, "listAll" | "seedCatalog">,
  seed: SeedDocument,
  dryRun: boolean,
): Promise<ProfileSeedReport | null> {
  const { profiles } = seed;
  if (profiles === null) return null;
  const repositoryIdsOf = catalogRepositoryIds(seed.entries.repositories);
  if (dryRun) {
    const rows = await store.listAll();
    if (rows.length === 0) installedRuntimes.assertProfiles(profiles);
    const missing = rows.filter(
      (row) => row.repository_ids === null && row.repository_scope !== null,
    );
    const seeded = rows.length === 0 ? Object.keys(profiles).sort() : [];
    return {
      seed: seeded,
      fill: missing.map((row) => row.id),
      unfilled: [...seeded, ...missing.map((row) => row.id)].filter(
        (id) => repositoryIdsOf(id).length === 0,
      ),
    };
  }
  const result = await store.seedCatalog({
    // Asked only while the table is empty: a filled one never reads the seed.
    entries: async () => {
      installedRuntimes.assertProfiles(profiles);
      return catalogImports(profiles);
    },
    repositoryIdsOf,
  });
  return {
    seed: result.seeded,
    fill: result.migrated,
    unfilled: [...result.seeded, ...result.migrated].filter(
      (id) => repositoryIdsOf(id).length === 0,
    ),
  };
}

type SettingsStores = {
  settings: Pick<
    SettingsDocumentStore,
    "exportEntries" | "importEntries" | "sessionsOnRepositories"
  >;
  profiles: Pick<InstallationProfileStore, "listAll" | "seedCatalog">;
};

export async function runSettingsCommand(
  command: SettingsCommand,
  stores: SettingsStores,
  output: Output,
): Promise<boolean> {
  if (command.command === "export") {
    const { entries, last4 } = await stores.settings.exportEntries();
    const document = settingsDocumentOf(entries, last4);
    output.out(JSON.stringify(document, null, 2));
    output.err(`digest ${settingsDocumentDigest(document)}`);
    return true;
  }
  const { source } = command;
  let seed: SeedDocument;
  let skipped: string[] = [];
  if ("dir" in source) {
    if (source.ifPresent && (await dirIsEmpty(source.dir))) {
      output.err(`nothing to import from ${source.dir}`);
      return true;
    }
    const read = await documentFromDir(source.dir);
    for (const note of read.notes) output.err(`note: ${note}`);
    skipped = read.skipped;
    seed = {
      entries: parseSeedDocument(read.document).entries,
      profiles: read.profiles,
    };
  } else {
    const document = await readDocument(source.document);
    const notes: string[] = [];
    seed = parseSeedDocument(
      document !== null &&
        typeof document === "object" &&
        !Array.isArray(document) &&
        Object.hasOwn(document, "repositories")
        ? {
            ...document,
            repositories: withoutLegacyRepositories(
              (document as { repositories: unknown }).repositories,
              notes,
              skipped,
            ),
          }
        : document,
      notes.length > 0,
    );
    for (const note of notes) output.err(`note: ${note}`);
  }
  // A session on a repository only the file knew would be failed by the
  // claim gate with nothing to hold it: stop before anything is written.
  const stranded = await stores.settings.sessionsOnRepositories(skipped);
  if (stranded.length > 0) {
    output.err(
      `refused: nothing changed; sessions still use repositories this import leaves out: ${stranded
        .map((row) => `${row.session_id} (${row.repository_id}, ${row.via})`)
        .join(", ")}`,
    );
    return false;
  }
  const result = await stores.settings.importEntries(seed.entries, {
    dryRun: command.dryRun,
    allowExternal: true,
    ...("dir" in source ? { databaseOwnsRepositories: true } : {}),
    actor: null,
  });
  if (result.outcome === "actor_inactive") {
    throw new Error("the operator's import has no actor to lose");
  }
  if (result.outcome === "refused") {
    output.out(JSON.stringify(result, null, 2));
    output.err(
      `refused: nothing changed (conflicts: ${result.conflicts.join(", ") || "none"})`,
    );
    return false;
  }
  for (const ref of result.kept ?? []) {
    output.err(
      `note: ${ref} from the file is not applied; the database keeps its row`,
    );
  }
  const profiles = await seedProfiles(stores.profiles, seed, command.dryRun);
  output.out(
    JSON.stringify(
      profiles === null ? result : { ...result, profiles },
      null,
      2,
    ),
  );
  if ((profiles?.unfilled.length ?? 0) > 0) {
    output.err(
      `note: no repository names these ceilings, so they run on none: ${profiles?.unfilled.join(", ")}`,
    );
  }
  if (result.outcome === "applied" && result.receipt_ids.length === 0) {
    if (result.add.length > 0) {
      output.err("note: no workspace yet, so no receipt was written");
    }
  }
  return true;
}

async function main(): Promise<void> {
  const command = parseSettingsCommand(Bun.argv.slice(2));
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger(),
    "settings",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    const ok = await runSettingsCommand(
      command,
      {
        settings: createPostgresSettingsDocumentStore(db),
        profiles: createPostgresInstallationProfileStore(db),
      },
      {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      },
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}

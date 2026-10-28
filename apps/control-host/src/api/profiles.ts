import * as schema from "@werft-ai/db";
import { createPostgresInstallationProfileStore } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  DEFAULT_CONFIG_DIR,
  loadCatalogConfig,
  loadProfileSources,
  secretsManagerReader,
} from "./catalog-config.ts";
import {
  checkCatalogImport,
  connectionsFromProfiles,
  type ImportCheck,
  importCheckClean,
} from "./profile-import.ts";

// The operator's profile migration commands
// (docs/contributing/decisions/profile-db.md §3). Run where keys.ts runs:
// inside the API image, against its database and its PLATFORM_CONFIG_DIR.
const USAGE = `Usage: bun run apps/control-host/src/api/profiles.ts import --check
       bun run apps/control-host/src/api/profiles.ts connections-from-yaml`;

export type ProfilesCommand = "import-check" | "connections-from-yaml";

export function parseProfilesCommand(argv: string[]): ProfilesCommand {
  if (argv.length === 2 && argv[0] === "import" && argv[1] === "--check") {
    return "import-check";
  }
  if (argv.length === 1 && argv[0] === "connections-from-yaml") {
    return "connections-from-yaml";
  }
  throw new Error(USAGE);
}

/** One line per finding, then the two revisions. */
export function describeImportCheck(check: ImportCheck): string[] {
  return [
    ...check.conflicts.map(
      (conflict) =>
        `conflict ${conflict.id} origin=${conflict.origin} fields=${conflict.fields.join(",") || "(none)"}`,
    ),
    ...check.databaseOnly.map((id) => `database_only ${id}`),
    ...check.yamlOnly.map((id) => `yaml_only ${id}`),
    ...check.connectionMissing.map((id) => `connection_missing ${id}`),
    `yaml_revision ${check.yamlRevision}`,
    `database_revision ${check.databaseRevision}`,
  ];
}

async function main(): Promise<void> {
  const command = parseProfilesCommand(Bun.argv.slice(2));
  const dir = Bun.env.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  if (command === "connections-from-yaml") {
    const config = await loadCatalogConfig({ dir, env: Bun.env });
    process.stdout.write(connectionsFromProfiles(config.profiles));
    return;
  }
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const loaded = await loadProfileSources({
    dir,
    env: Bun.env,
    readSecret: secretsManagerReader(Bun.env),
  });
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger(),
    "profiles",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    const check = checkCatalogImport({
      sources: loaded.sources,
      repositories: loaded.catalog.repositories,
      rows: await createPostgresInstallationProfileStore(db).listAll(),
    });
    for (const line of describeImportCheck(check)) console.log(line);
    if (!importCheckClean(check)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}

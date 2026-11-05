/**
 * Read-only report before the repository migration (R2), run on the host
 * against an installation's published database port. It writes nothing: the
 * pool and the snapshot transaction are both read only. See
 * scripts/lib/repository-migration-report.ts for what each section means.
 *
 *   DATABASE_URL=... bun run scripts/lib/repository-migration-report-cli.ts [--no-confirmed]
 *
 * `--no-confirmed` is for a stack whose running image no longer loads URL
 * repositories into its catalog: the confirmed count is then 'not
 * applicable'. The JSON report goes to stdout, a short summary to stderr.
 * The report carries ids and counts, never a repository URL or credential.
 */

import {
  createPostgresCatalogRepositoryStore,
  createPostgresInstallationProfileStore,
  createPostgresInstallationSettingsStore,
  createPostgresWorkspaceProfileStore,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { databaseCatalog } from "../../apps/control-host/src/api/catalog-config.ts";
import { generateReport, summarize } from "./repository-migration-report.ts";

const args = process.argv.slice(2);
const noConfirmed = args.includes("--no-confirmed");
if (args.some((arg) => arg !== "--no-confirmed")) {
  console.error(
    "usage: repository-migration-report-cli.ts [--no-confirmed] (DATABASE_URL in the environment)",
  );
  process.exit(2);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}

const pool = createEnforcedPool(
  databaseUrl,
  createLogger(),
  "repository-migration-report",
  JOB_POOL_TIMEOUTS,
  { readOnly: true },
);
try {
  const report = await generateReport(
    pool,
    noConfirmed
      ? null
      : (db) =>
          databaseCatalog({
            installations: createPostgresInstallationProfileStore(db),
            workspaces: createPostgresWorkspaceProfileStore(db),
            repositories: createPostgresCatalogRepositoryStore(db),
            settings: createPostgresInstallationSettingsStore(db, null),
            // The report reads no credential: a stand-in resolves them.
            credential: () => "repository-migration-report-reads-no-credential",
            env: process.env,
          }),
  );
  console.log(JSON.stringify(report, null, 2));
  for (const line of summarize(report)) console.error(line);
} finally {
  await pool.end();
}

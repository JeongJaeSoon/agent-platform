/**
 * Write side of the repository migration (R2). Run it by hand on the host
 * against an installation's published database port, after the read-only
 * report (repository-migration-report-cli.ts) and with the stack quiet: it
 * does not stop sessions from being created while it runs.
 *
 *   DATABASE_URL=... bun run scripts/lib/repository-migration-write-cli.ts plan
 *   DATABASE_URL=... bun run scripts/lib/repository-migration-write-cli.ts apply --before-image <new file>
 *   DATABASE_URL=... bun run scripts/lib/repository-migration-write-cli.ts revert --before-image <file>
 *
 * `plan` is read only. `apply` refuses a before-image path that exists and
 * writes none when nothing changes. Keep the file: `revert` needs nothing
 * else. The JSON result goes to stdout, a short summary to stderr.
 */

import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  applyMigration,
  planMigration,
  revertMigration,
  summarizeApply,
} from "./repository-migration-write.ts";

const usage =
  "usage: repository-migration-write-cli.ts plan | apply --before-image <file> | revert --before-image <file> (DATABASE_URL in the environment)";
const [command, flag, path, ...extra] = process.argv.slice(2);
const needsFile = command === "apply" || command === "revert";
if (
  (command !== "plan" && !needsFile) ||
  (needsFile && (flag !== "--before-image" || !path)) ||
  (command === "plan" && flag !== undefined) ||
  extra.length > 0
) {
  console.error(usage);
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
  "repository-migration-write",
  JOB_POOL_TIMEOUTS,
  { readOnly: command === "plan" },
);
try {
  if (command === "plan") {
    const plan = await planMigration(pool);
    console.log(JSON.stringify(plan, null, 2));
    console.error(
      `plan: ${plan.agent_rows.length} agent row(s), ${plan.agent_rows_skipped.length} skipped, ${plan.workspace_ceilings.length} workspace(s), ${plan.ceiling_unset.length} without a ceiling`,
    );
  } else if (command === "apply") {
    const result = await applyMigration(pool, path as string);
    console.log(JSON.stringify(result, null, 2));
    for (const line of summarizeApply(result)) console.error(line);
  } else {
    const result = await revertMigration(pool, path as string);
    console.log(JSON.stringify(result, null, 2));
    console.error(
      `revert ${result.migration_id}: ${result.agent_rows.filter((r) => r.outcome === "reverted").length} agent row(s), ${result.workspace_ceilings.filter((r) => r.outcome === "reverted").length} ceiling(s) reverted; ${[...result.agent_rows, ...result.workspace_ceilings].filter((r) => r.outcome === "changed_since").length} left as changed since`,
    );
  }
} finally {
  await pool.end();
}

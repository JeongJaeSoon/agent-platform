import { parseArgs } from "node:util";
import * as schema from "@agent-platform/db";
import {
  type ActivateCatalogResult,
  activateCatalogRevision,
  activeCatalogRevision,
  type CatalogAuthority,
} from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { createLogger } from "@agent-platform/observability";
import { drizzle } from "drizzle-orm/node-postgres";

// The operator's catalog activation (94S-295). The API never activates the
// catalog it loads: with several replicas mid-rollout, whichever started last
// would win. The revision to activate is the one each replica logs at
// startup ("Session catalog loaded", `revision`).
const USAGE = `Usage: bun run apps/control-host/src/api/catalog-authority.ts show
       bun run apps/control-host/src/api/catalog-authority.ts activate <revision> --expected <revision|none>`;

const REVISION = /^sha256:[0-9a-f]{64}$/;

export type CatalogAuthorityCommand =
  | { command: "show" }
  | { command: "activate"; revision: string; expected: string | null };

export function parseCatalogAuthorityCommand(
  argv: string[],
): CatalogAuthorityCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
  const [command, revision, ...extra] = parsed.positionals;
  if (command === "show" && revision === undefined) {
    if (parsed.values.expected !== undefined) throw new Error(USAGE);
    return { command };
  }
  if (command !== "activate" || !revision || extra.length > 0) {
    throw new Error(USAGE);
  }
  if (!REVISION.test(revision)) {
    throw new Error(
      `revision must be sha256: and 64 lowercase hex characters, as the API logs it\n${USAGE}`,
    );
  }
  // Required, so nobody replaces an activation they never looked at.
  const expected = parsed.values.expected;
  if (expected === undefined) {
    throw new Error(`--expected is required\n${USAGE}`);
  }
  if (expected !== "none" && !REVISION.test(expected)) {
    throw new Error(`--expected must be a revision or "none"\n${USAGE}`);
  }
  return {
    command,
    revision,
    expected: expected === "none" ? null : expected,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { expected: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
}

function describeAuthority(authority: CatalogAuthority | null): string {
  return authority === null
    ? "none"
    : `${authority.revision} activated_at=${authority.activatedAt.toISOString()}`;
}

/** One line for the operator, and whether the command did what it asked. */
export function describeActivation(result: ActivateCatalogResult): {
  ok: boolean;
  line: string;
} {
  return result.outcome === "activated"
    ? { ok: true, line: `activated ${describeAuthority(result.authority)}` }
    : {
        ok: false,
        line: `conflict: the active revision is ${describeAuthority(result.current)}; nothing changed`,
      };
}

async function main(): Promise<void> {
  const command = parseCatalogAuthorityCommand(Bun.argv.slice(2));
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger(),
    "catalog-authority",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    if (command.command === "show") {
      console.log(
        `active ${describeAuthority(await activeCatalogRevision(db))}`,
      );
      return;
    }
    const { ok, line } = describeActivation(
      await activateCatalogRevision(db, command),
    );
    if (ok) {
      console.log(line);
    } else {
      console.error(line);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}

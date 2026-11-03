import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as schema from "@werft-ai/db";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  parseSettingsDocument,
  type SettingsDocument,
  type SettingsDocumentStore,
  type SettingsEntries,
  settingsDocumentDigest,
  settingsDocumentOf,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  PLATFORM_FILE,
  PROFILES_FILE,
  readCatalogConfig,
  readConnections,
} from "./catalog-config.ts";

// The operator's settings import and export
// (docs/contributing/decisions/settings-replace-file-catalog.md §5, §6).
// Run where keys.ts runs, against the database: unlike the API's import it
// may bring in env and Secrets Manager references, since whoever reaches
// the database already holds the deployment.
const USAGE = `Usage: bun run apps/control-host/src/api/settings.ts export
       bun run apps/control-host/src/api/settings.ts import (--document <file|-> | --from-dir <dir>) [--dry-run]`;

export type SettingsCommand =
  | { command: "export" }
  | {
      command: "import";
      source: { document: string } | { dir: string };
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
      values["dry-run"] !== undefined
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
  return {
    command,
    source: document !== undefined ? { document } : { dir: dir as string },
    dryRun: values["dry-run"] === true,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      document: { type: "string" },
      "from-dir": { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

/**
 * The old catalog directory as a settings document: connections.yaml,
 * repositories.yaml and mcp-servers.yaml under their own rules. What else
 * the directory holds is named in `notes`: the ceilings stay with the API's
 * profiles.yaml seed, and the master key with PLATFORM_SECRET_KEY.
 */
export async function documentFromDir(
  dir: string,
): Promise<{ document: SettingsDocument; notes: string[] }> {
  const config = await readCatalogConfig(dir);
  const entries: SettingsEntries = {
    connections: { ...(await readConnections(dir)) },
    repositories: config.repositories,
    mcp_servers: config.mcp_servers ?? {},
  };
  const notes: string[] = [];
  if (await Bun.file(resolve(dir, PROFILES_FILE)).exists()) {
    notes.push(
      `${PROFILES_FILE} is not part of the settings document: the API still seeds an empty installation's ceilings from it`,
    );
  }
  if (await Bun.file(resolve(dir, PLATFORM_FILE)).exists()) {
    notes.push(
      `${PLATFORM_FILE} is not part of the settings document: the master key is the deployment's (PLATFORM_SECRET_KEY)`,
    );
  }
  return { document: settingsDocumentOf(entries), notes };
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

/** Runs `command` against `store`; false when the import was refused. */
export async function runSettingsCommand(
  command: SettingsCommand,
  store: SettingsDocumentStore,
  output: Output,
): Promise<boolean> {
  if (command.command === "export") {
    const { entries, last4 } = await store.exportEntries();
    const document = settingsDocumentOf(entries, last4);
    output.out(JSON.stringify(document, null, 2));
    output.err(`digest ${settingsDocumentDigest(document)}`);
    return true;
  }
  let document: unknown;
  if ("dir" in command.source) {
    const read = await documentFromDir(command.source.dir);
    for (const note of read.notes) output.err(`note: ${note}`);
    document = read.document;
  } else {
    document = await readDocument(command.source.document);
  }
  const result = await store.importEntries(parseSettingsDocument(document), {
    dryRun: command.dryRun,
    allowExternal: true,
    actor: null,
  });
  if (result.outcome === "actor_inactive") {
    throw new Error("the operator's import has no actor to lose");
  }
  output.out(JSON.stringify(result, null, 2));
  if (result.outcome === "refused") {
    output.err(
      `refused: nothing changed (conflicts: ${result.conflicts.join(", ") || "none"})`,
    );
    return false;
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
    const ok = await runSettingsCommand(
      command,
      createPostgresSettingsDocumentStore(drizzle(pool, { schema })),
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

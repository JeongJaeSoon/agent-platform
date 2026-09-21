import type { ReadinessCheck } from "@agent-platform/contracts";
import {
  APPLIED_MIGRATIONS_SQL,
  expectedMigrationHead,
  expectedMigrations,
  type MigrationEntry,
  type MigrationHead,
} from "@agent-platform/db";
import type { StructuredLogger } from "@agent-platform/observability";
import { Pool } from "pg";

export type ReadinessResult =
  | { ready: true }
  | { ready: false; check: ReadinessCheck; reason: string };

export type ReadinessProbe = () => Promise<ReadinessResult>;

export interface QueryRunner {
  // Rows of a raw SQL statement; pg.Pool satisfies this directly.
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

// A pool of its own so probe traffic never competes with API requests for
// clients. statement_timeout makes the server cancel a statement the probe
// gave up on instead of leaving it running; the client-side query_timeout is
// only the fallback for a socket the server can no longer answer on, so it
// fires later.
export function createProbePool(
  connectionString: string,
  logger: StructuredLogger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Pool {
  return watchIdleErrors(
    new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs * 2,
    }),
    logger,
    "probe",
  );
}

// pg-pool emits "error" for an idle client whose backend went away; with no
// listener that is an uncaught exception and the process dies on a database
// restart instead of answering 503 until it is back.
export function watchIdleErrors(
  pool: Pool,
  logger: StructuredLogger,
  name: string,
): Pool {
  pool.on("error", (error) => {
    logger.warn("Idle database connection dropped", {
      pool: name,
      error_name: error.name,
      code: (error as { code?: string }).code ?? null,
    });
  });
  return pool;
}

export interface CreateReadinessProbeOptions {
  readonly db: QueryRunner;
  // Variable names that must be set and non-empty.
  readonly requiredEnv: readonly string[];
  readonly environment?: Record<string, string | undefined>;
  readonly expected?: { head: MigrationHead; migrations: MigrationEntry[] };
  // Last-resort bound for each database step when the runner has no
  // timeouts of its own (see createProbePool); it abandons the promise, so
  // the runner itself must free the connection.
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function migrationDrift(
  expected: MigrationEntry[],
  applied: { when: string; hash: string }[],
): string | null {
  const length = Math.max(expected.length, applied.length);
  for (let index = 0; index < length; index += 1) {
    const want = expected[index];
    const have = applied[index];
    if (!want) {
      return `database has ${applied.length - expected.length} unknown migration(s) after ${have?.when}`;
    }
    if (!have) {
      return `database is missing migration ${want.when}`;
    }
    if (have.when !== String(want.when) || have.hash !== want.hash) {
      return `migration ${index} differs (expected ${want.when}/${want.hash.slice(0, 12)}, database ${have.when}/${have.hash.slice(0, 12)})`;
    }
  }
  return null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// database → schema → config, stopping at the first failure. Nothing here
// touches the execution backend: api.md keeps backend health out of readiness.
export function createReadinessProbe(
  options: CreateReadinessProbeOptions,
): ReadinessProbe {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expected = options.expected ?? {
    head: expectedMigrationHead(),
    migrations: expectedMigrations(),
  };
  return async () => {
    try {
      await withTimeout(options.db.query("SELECT 1"), timeoutMs);
    } catch (error) {
      return { ready: false, check: "database", reason: describe(error) };
    }
    let applied: { when: string; hash: string }[];
    try {
      const result = await withTimeout(
        options.db.query(APPLIED_MIGRATIONS_SQL),
        timeoutMs,
      );
      applied = result.rows.map((row) => ({
        when: String(row.when),
        hash: String(row.hash),
      }));
    } catch (error) {
      // 42P01 (relation missing) lands here too: no journal table means the
      // database was never migrated.
      return { ready: false, check: "schema", reason: describe(error) };
    }
    // The whole chain, not only its head: a missing or rewritten earlier
    // migration leaves the head intact while the schema differs from the one
    // this build's SQL produces.
    const drift = migrationDrift(expected.migrations, applied);
    if (drift) {
      return {
        ready: false,
        check: "schema",
        reason: `expected migrations up to ${expected.head.tag}: ${drift}`,
      };
    }
    const missing = options.requiredEnv.filter(
      (name) => !environment[name]?.trim(),
    );
    if (missing.length > 0) {
      return {
        ready: false,
        check: "config",
        reason: `missing configuration: ${missing.join(", ")}`,
      };
    }
    return { ready: true };
  };
}

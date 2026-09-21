import type { ReadinessCheck } from "@agent-platform/contracts";
import {
  APPLIED_MIGRATION_HEAD_SQL,
  expectedMigrationHead,
  type MigrationHead,
} from "@agent-platform/db";
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Pool {
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs * 2,
  });
}

export interface CreateReadinessProbeOptions {
  readonly db: QueryRunner;
  // Variable names that must be set and non-empty.
  readonly requiredEnv: readonly string[];
  readonly environment?: Record<string, string | undefined>;
  readonly expectedHead?: MigrationHead;
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
  const expected = options.expectedHead ?? expectedMigrationHead();
  return async () => {
    try {
      await withTimeout(options.db.query("SELECT 1"), timeoutMs);
    } catch (error) {
      return { ready: false, check: "database", reason: describe(error) };
    }
    let head: { applied?: unknown; hash?: unknown } | undefined;
    try {
      const result = await withTimeout(
        options.db.query(APPLIED_MIGRATION_HEAD_SQL),
        timeoutMs,
      );
      head = result.rows[0];
    } catch (error) {
      // 42P01 (relation missing) lands here too: no journal table means the
      // database was never migrated.
      return { ready: false, check: "schema", reason: describe(error) };
    }
    // Same timestamp with a different hash means the SQL behind the journal
    // row is not the SQL this build shipped: treat it as a different schema.
    if (
      head?.applied !== String(expected.when) ||
      head.hash !== expected.hash
    ) {
      return {
        ready: false,
        check: "schema",
        reason: `expected migration ${expected.tag} (${expected.when}, ${expected.hash.slice(0, 12)}), database has ${head ? `${head.applied} (${String(head.hash).slice(0, 12)})` : "none"}`,
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

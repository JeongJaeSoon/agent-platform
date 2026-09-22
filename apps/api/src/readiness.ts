import type { ReadinessCheck } from "@agent-platform/contracts";
import {
  APPLIED_MIGRATIONS_SQL,
  expectedMigrationHead,
  expectedMigrations,
  type MigrationEntry,
  type MigrationHead,
} from "@agent-platform/db";

export type ReadinessResult =
  | { ready: true }
  | { ready: false; check: ReadinessCheck; reason: string };

export type ReadinessProbe = () => Promise<ReadinessResult>;

export interface QueryRunner {
  // Rows of a raw SQL statement; pg.Pool satisfies this directly.
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

// A bare name must be set and non-empty; with `allowed`, its trimmed value
// must also be one of those.
export type RequiredEnv =
  | string
  | { readonly name: string; readonly allowed: readonly string[] };

export interface CreateReadinessProbeOptions {
  readonly db: QueryRunner;
  readonly requiredEnv: readonly RequiredEnv[];
  readonly environment?: Record<string, string | undefined>;
  readonly expected?: { head: MigrationHead; migrations: MigrationEntry[] };
  // Last-resort bound for each database step when the runner has no
  // timeouts of its own (see createProbePool in pool.ts); it abandons the
  // promise, so the runner itself must free the connection.
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;

function configProblems(
  required: readonly RequiredEnv[],
  environment: Record<string, string | undefined>,
): string[] {
  return required.flatMap((entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const value = environment[name]?.trim();
    if (!value) return [`missing ${name}`];
    if (typeof entry !== "string" && !entry.allowed.includes(value)) {
      return [`${name} must be one of ${entry.allowed.join("|")}`];
    }
    return [];
  });
}

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

// The packaged migrations must be an exact prefix of the applied ones.
function migrationDrift(
  expected: MigrationEntry[],
  applied: { when: string; hash: string }[],
): string | null {
  for (let index = 0; index < expected.length; index += 1) {
    const want = expected[index] as MigrationEntry;
    const have = applied[index];
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
    // this build's SQL produces. Rows after this build's last migration are
    // fine: DESIGN.md §11.5 applies migrations in a Job before the rollout,
    // so the previous build must stay ready on a database that is one step
    // ahead, and only rollback-compatible changes ship.
    const drift = migrationDrift(expected.migrations, applied);
    if (drift) {
      return {
        ready: false,
        check: "schema",
        reason: `expected migrations up to ${expected.head.tag}: ${drift}`,
      };
    }
    const problems = configProblems(options.requiredEnv, environment);
    if (problems.length > 0) {
      return {
        ready: false,
        check: "config",
        reason: `configuration: ${problems.join(", ")}`,
      };
    }
    return { ready: true };
  };
}

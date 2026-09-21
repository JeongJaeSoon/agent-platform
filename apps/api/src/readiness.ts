import type { ReadinessCheck } from "@agent-platform/contracts";
import {
  APPLIED_MIGRATION_HEAD_SQL,
  expectedMigrationHead,
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

export interface CreateReadinessProbeOptions {
  readonly db: QueryRunner;
  // Variable names that must be set and non-empty.
  readonly requiredEnv: readonly string[];
  readonly environment?: Record<string, string | undefined>;
  readonly expectedHead?: MigrationHead;
  // Upper bound for each database step so a hung socket cannot stall the
  // probe past the orchestrator's own timeout.
  readonly timeoutMs?: number;
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// database → schema → config, stopping at the first failure. Nothing here
// touches the execution backend: api.md keeps backend health out of readiness.
export function createReadinessProbe(
  options: CreateReadinessProbeOptions,
): ReadinessProbe {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const expected = options.expectedHead ?? expectedMigrationHead();
  return async () => {
    try {
      await withTimeout(options.db.query("SELECT 1"), timeoutMs);
    } catch (error) {
      return { ready: false, check: "database", reason: describe(error) };
    }
    let applied: string | null;
    try {
      const result = await withTimeout(
        options.db.query(APPLIED_MIGRATION_HEAD_SQL),
        timeoutMs,
      );
      applied = (result.rows[0]?.applied as string | null | undefined) ?? null;
    } catch (error) {
      // 42P01 (relation missing) lands here too: no journal table means the
      // database was never migrated.
      return { ready: false, check: "schema", reason: describe(error) };
    }
    if (applied !== String(expected.when)) {
      return {
        ready: false,
        check: "schema",
        reason: `expected migration ${expected.tag} (${expected.when}), database has ${applied ?? "none"}`,
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

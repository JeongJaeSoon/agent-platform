import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@agent-platform/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "../src/control-unit-of-work.ts";
import * as schema from "../src/schema.ts";
import { executions, sessions, workerLaunches } from "../src/schema.ts";

const CONCURRENCY = 10;
const TERMINATES_PER_ROUND = 5;
const P95_LIMIT_MS = 500;

type SeededSession = {
  id: string;
  ownerId: string;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("BENCH_ROUNDS must be a positive integer");
  }
  return parsed;
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error("no benchmark samples");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(percentile * sorted.length) - 1] as number;
}

async function seedRound(
  db: NodePgDatabase<typeof schema>,
  round: number,
): Promise<SeededSession[]> {
  const seeded = Array.from({ length: CONCURRENCY }, (_, index) => ({
    id: crypto.randomUUID(),
    ownerId: `bench-owner-${round}-${index}-${crypto.randomUUID()}`,
  }));
  const bound = seeded.slice(0, TERMINATES_PER_ROUND).map((session) => ({
    ...session,
    executionId: `bench-exec-${crypto.randomUUID()}`,
  }));

  await db.transaction(async (tx) => {
    await tx.insert(sessions).values([
      ...bound.map(({ id, ownerId, executionId }) => ({
        id,
        ownerId,
        repoUrl: "https://example.invalid/bench.git",
        branch: "main",
        status: "running" as const,
        executionId,
        executionGeneration: 1,
      })),
      ...seeded.slice(TERMINATES_PER_ROUND).map(({ id, ownerId }) => ({
        id,
        ownerId,
        repoUrl: "https://example.invalid/bench.git",
        branch: "main",
        checkpointRevision: 1,
      })),
    ]);
    await tx.insert(executions).values(
      bound.map(({ id, executionId }) => ({
        id: executionId,
        sessionId: id,
        backend: "local_docker",
        generation: 1,
        desiredState: "running",
        observedState: "running",
      })),
    );
    await tx.insert(workerLaunches).values(
      bound.map(({ id, executionId }) => ({
        executionId,
        sessionId: id,
        backend: "local_docker",
        generation: 1,
      })),
    );
  });

  return seeded;
}

async function main() {
  if (!testDatabaseUrl()) {
    throw new Error(
      "QUEUE_DATABASE_URL is required for the terminate benchmark",
    );
  }
  const rounds = positiveInteger(process.env.BENCH_ROUNDS, 20);
  const database = await createTempDatabase({ prefix: "terminate_bench" });
  const pool = new Pool({ connectionString: database.url, max: CONCURRENCY });
  const db = drizzle(pool, { schema });
  const sink = new MemoryLogSink();
  const logger = createLogger({ sinks: [sink] });
  const controls = createPostgresSessionControl(db, {
    connect: () => pool.connect(),
    logger,
  });
  const terminateDurations: number[] = [];

  try {
    for (let round = 0; round < rounds; round += 1) {
      const seeded = await seedRound(db, round);
      await Promise.all(
        seeded.map(async (session, index) => {
          const started = performance.now();
          const common = {
            principal: { ownerId: session.ownerId },
            sessionId: session.id,
            idempotencyKey: crypto.randomUUID(),
            payloadHash: crypto.randomUUID(),
            expectedRevision: 0,
            reason: "terminate latency benchmark",
            now: new Date(),
          };
          const result =
            index < TERMINATES_PER_ROUND
              ? await controls.terminateAtomic(common)
              : await controls.pauseAtomic(common);
          if (result.outcome !== "accepted") {
            throw new Error(
              `${index < TERMINATES_PER_ROUND ? "terminate" : "pause"} returned ${result.outcome}`,
            );
          }
          if (index < TERMINATES_PER_ROUND) {
            terminateDurations.push(performance.now() - started);
          }
        }),
      );
    }

    const stageNames = new Set(
      sink.records.flatMap((record) => Object.keys(record.fields ?? {})),
    );
    const stageP95 = Object.fromEntries(
      [...stageNames]
        .filter((name) => name.endsWith("_ms") && name !== "duration_ms")
        .sort()
        .map((name) => [
          name,
          nearestRank(
            sink.records.flatMap((record) => {
              const value = record.fields?.[name];
              return typeof value === "number" ? [value] : [];
            }),
            0.95,
          ),
        ]),
    );
    const p95Ms = nearestRank(terminateDurations, 0.95);
    console.log(
      JSON.stringify({
        benchmark: "terminate-control",
        concurrency: CONCURRENCY,
        mixed_controls: { pause: 5, terminate: 5 },
        samples: terminateDurations.length,
        p50_ms: Math.round(nearestRank(terminateDurations, 0.5)),
        p95_ms: Math.round(p95Ms),
        max_ms: Math.round(Math.max(...terminateDurations)),
        threshold_ms: P95_LIMIT_MS,
        stage_p95_ms: stageP95,
      }),
    );
    if (p95Ms > P95_LIMIT_MS) {
      throw new Error(
        `terminate nearest-rank p95 ${Math.round(p95Ms)}ms exceeds ${P95_LIMIT_MS}ms`,
      );
    }
  } finally {
    await pool.end();
    await database.drop();
  }
}

await main();

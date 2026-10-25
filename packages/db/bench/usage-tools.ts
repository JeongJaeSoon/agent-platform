/**
 * What GET /v1/usage/tools costs on real PostgreSQL when a whole installation
 * runs `per-day` sessions a day for `days` days, each with `events` events of
 * which 30% are tool_use and 30% their tool_result. One user in `users`
 * started each session in turn, so a `me` read sums 1/users of them. Seeds
 * only an empty database (pass a fresh one; the timings rerun on the same
 * data), and PGlite timings do not carry over, hence the URL.
 *
 *   bun packages/db/bench/usage-tools.ts <postgres-url> [per-day] [days] [events] [users]
 */
import { performance } from "node:perf_hooks";
import type { UsageSummaryFilter } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "../src/index.ts";
import { createPostgresUsageReader } from "../src/index.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: usage-tools.ts <postgres-url> ...");
const perDay = Number(process.argv[3] ?? 100);
const days = Number(process.argv[4] ?? 90);
const eventsPerSession = Number(process.argv[5] ?? 2000);
const userCount = Number(process.argv[6] ?? 20);
const RUNS = 10;
const OWNER = "bench-owner";

const pool = new Pool({ connectionString: url, max: 2 });
const db = drizzle(pool, { schema });
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const empty = await pool.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM sessions",
);
if (empty.rows[0]?.n === 0) {
  const seeded = performance.now();
  await pool.query(`
    INSERT INTO users (id, email, display_name)
    SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           'bench-' || g || '@example.invalid', 'bench ' || g
    FROM generate_series(1, ${userCount}) g`);
  // Sessions spread evenly over the period, newest first.
  await pool.query(`
    INSERT INTO sessions (id, owner_id, repo_url, branch, created_by_user_id, created_at)
    SELECT gen_random_uuid(), '${OWNER}', 'https://example.invalid/app.git', 'main',
           ('00000000-0000-4000-8000-' || lpad((1 + g % ${userCount})::text, 12, '0'))::uuid,
           now() - g * (interval '1 day' * ${days} / ${perDay * days})
    FROM generate_series(1, ${perDay * days}) g`);
  // Per ten events: three tool_use, then their three results, then four
  // other messages. Tool names are skewed so a few dominate, as in use.
  await pool.query(`
    INSERT INTO events (session_id, type, payload, attempt_id, source_sequence, occurred_at, created_at)
    SELECT s.id,
           CASE WHEN e % 10 < 3 THEN 'tool_use' WHEN e % 10 < 6 THEN 'tool_result' ELSE 'assistant' END,
           CASE
             WHEN e % 10 < 3 THEN jsonb_build_object(
               'type', 'assistant', 'parent_tool_use_id', null,
               'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(
                 jsonb_build_object('type', 'tool_use', 'id', 'tu_' || (e / 10) || '_' || (e % 10),
                   'name', (ARRAY['Bash','Bash','Bash','Read','Read','Edit','Grep','WebFetch','Task','mcp__linear__get_issue'])[1 + (e * 7 + s.n) % 10],
                   'input', jsonb_build_object('command', repeat('x', 80))))))
             WHEN e % 10 < 6 THEN jsonb_build_object(
               'type', 'tool_result', 'tool_use_id', 'tu_' || (e / 10) || '_' || (e % 10 - 3),
               'is_error', (e + s.n) % 50 = 0, 'content', repeat('y', 200))
             ELSE jsonb_build_object('type', 'assistant', 'message',
               jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(
                 jsonb_build_object('type', 'text', 'text', repeat('z', 160)))))
           END,
           'att_' || s.n, e,
           s.created_at + e * interval '900 milliseconds' + (CASE WHEN e % 10 BETWEEN 3 AND 5 THEN (e % 7) * interval '400 milliseconds' ELSE interval '0' END),
           s.created_at + e * interval '900 milliseconds'
    FROM (SELECT id, created_at, row_number() OVER (ORDER BY created_at) AS n FROM sessions) s,
         generate_series(1, ${eventsPerSession}) e`);
  await pool.query("ANALYZE");
  console.log(`seeded in ${((performance.now() - seeded) / 1000).toFixed(1)}s`);
}
const counts = await pool.query(`
  SELECT (SELECT count(*)::int FROM sessions) AS sessions,
         (SELECT count(*)::bigint FROM events) AS events,
         pg_size_pretty(pg_total_relation_size('events')) AS events_size,
         (SELECT string_agg(indexname, ', ') FROM pg_indexes WHERE tablename = 'events') AS events_indexes`);
console.log(JSON.stringify(counts.rows[0]));

const reader = createPostgresUsageReader(db);
const DAY = 86_400_000;
const sinceDays = (n: number) => ({
  period: { since: new Date(Date.now() - n * DAY) },
});
const installation: UsageSummaryFilter = { kind: "installation" };
const me: UsageSummaryFilter = {
  kind: "user",
  ownerId: OWNER,
  userId: "00000000-0000-4000-8000-000000000001",
};

async function timed(fn: () => Promise<unknown>) {
  await fn();
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    Number((samples[Math.ceil(q * samples.length) - 1] ?? 0).toFixed(1));
  return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}

console.table({
  "installation 7d": await timed(() =>
    reader.usageTools(installation, sinceDays(7), 200),
  ),
  "installation 30d": await timed(() =>
    reader.usageTools(installation, sinceDays(30), 200),
  ),
  "installation 90d": await timed(() =>
    reader.usageTools(installation, sinceDays(90), 200),
  ),
  "me 90d": await timed(() => reader.usageTools(me, sinceDays(90), 200)),
});

// The statement usageTools runs, as drizzle renders it, under EXPLAIN.
async function explain(label: string, filter: UsageSummaryFilter, n: number) {
  const logged: { sql: string; params: unknown[] }[] = [];
  const logging = drizzle(pool, {
    schema,
    logger: { logQuery: (sql, params) => logged.push({ sql, params }) },
  });
  await createPostgresUsageReader(logging).usageTools(
    filter,
    sinceDays(n),
    200,
  );
  const [query] = logged;
  if (!query) throw new Error("no statement logged");
  const plan = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
    query.params,
  );
  console.log(`\n-- ${label}`);
  for (const row of plan.rows) console.log(row["QUERY PLAN"]);
}

await explain("installation 90d", installation, 90);
await explain("me 90d", me, 90);
await pool.end();

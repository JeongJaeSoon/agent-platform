import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * The provider token backfill, run against the schema just before it with
 * ledger rows already written. Found by name so a renumbering restack does
 * not break it.
 */
const migrations = join(import.meta.dir, "../migrations");

let client: PGlite;
let backfill: string;

async function apply(file: string): Promise<void> {
  const sql = await readFile(join(migrations, file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await client.exec(statement);
  }
}

async function seedAttempt(): Promise<{
  sessionId: string;
  attemptId: string;
}> {
  const sessionId = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, cost_usd) VALUES ($1, 'owner-a', 'https://example.invalid/r.git', $2, 1.5)`,
    [sessionId, `session/${sessionId}`],
  );
  const executionId = `exec-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
     VALUES ($1, $2, 'local_docker', 1, 'running', 'running')`,
    [executionId, sessionId],
  );
  const attemptId = `att-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
     VALUES ($1, $2, $3, 1, 1, 1, 'exited', now())`,
    [attemptId, sessionId, executionId],
  );
  return { sessionId, attemptId };
}

async function seedUsage(
  at: { sessionId: string; attemptId: string },
  tokens: {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_read_input_tokens, estimated, cost_usd, priced_by)
     VALUES ($1, $2, $3, 'claude-sonnet-4-5', $4, $5, $6, $6, $7, false, 0.5, 'table')`,
    [
      crypto.randomUUID(),
      at.sessionId,
      at.attemptId,
      tokens.input,
      tokens.output,
      tokens.cacheWrite,
      tokens.cacheRead,
    ],
  );
}

async function tokensOf(sessionId: string) {
  const result = await client.query<{
    provider_tokens: string;
    cost_usd: string;
  }>("SELECT provider_tokens, cost_usd FROM sessions WHERE id = $1", [
    sessionId,
  ]);
  const row = result.rows[0];
  return { tokens: Number(row?.provider_tokens), costUsd: row?.cost_usd };
}

beforeEach(async () => {
  const files = (await readdir(migrations))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const found = files.find((name) =>
    name.endsWith("_session_provider_tokens.sql"),
  );
  if (!found) throw new Error("session_provider_tokens migration not found");
  backfill = found;
  client = new PGlite();
  for (const file of files.filter((name) => name < backfill)) {
    await apply(file);
  }
});

afterEach(async () => {
  await client.close();
});

describe("session provider token backfill", () => {
  test("sums every metered call's tokens per session and leaves the cost alone", async () => {
    const metered = await seedAttempt();
    await seedUsage(metered, {
      input: 100,
      cacheWrite: 20,
      cacheRead: 30,
      output: 50,
    });
    await seedUsage(metered, {
      input: 1,
      cacheWrite: 0,
      cacheRead: 0,
      output: 2,
    });
    const other = await seedAttempt();
    await seedUsage(other, {
      input: 7,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });
    const unmetered = await seedAttempt();

    await apply(backfill);

    expect(await tokensOf(metered.sessionId)).toEqual({
      tokens: 203,
      costUsd: "1.500000",
    });
    expect((await tokensOf(other.sessionId)).tokens).toBe(7);
    expect((await tokensOf(unmetered.sessionId)).tokens).toBe(0);
  });
});

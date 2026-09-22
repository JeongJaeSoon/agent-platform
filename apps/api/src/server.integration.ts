import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import { apiKeys } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

// Idle this whole test runs in ~0.4s (bun 1.3.11, 14-core M-series), but a
// loaded 4-core GitHub runner has pushed server startup past the old 5s wall
// (94S-256). 30s is the ratio 94S-241 chose: far above any observed startup,
// well below "hung", and the test timeout leaves room for the assertions
// that follow.
const SERVER_START_DEADLINE_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;

// Polls `url` until the server answers, the server exits, or the deadline
// passes. Exit and deadline both fail with the server's stderr attached, so
// a startup error (bad DATABASE_URL, port in use) is readable from the
// assertion instead of surfacing as an `undefined` status.
async function waitForServer(
  server: Bun.Subprocess,
  stderr: Promise<string>,
  request: { url: string; headers: Record<string, string> },
): Promise<Response> {
  const exited = server.exited.then((exitCode) => ({ exitCode }));
  const deadline = Date.now() + SERVER_START_DEADLINE_MS;
  while (true) {
    const outcome = await Promise.race([
      fetch(request.url, { headers: request.headers }).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      ),
      exited,
    ]);
    if ("response" in outcome) return outcome.response;
    if ("exitCode" in outcome) {
      throw new Error(
        `server exited with code ${outcome.exitCode} before accepting connections\nstderr:\n${await stderr}`,
      );
    }
    if (Date.now() >= deadline) {
      server.kill("SIGTERM");
      await server.exited;
      throw new Error(
        `server did not accept connections within ${SERVER_START_DEADLINE_MS}ms (last error: ${String(outcome.error)})\nstderr:\n${await stderr}`,
      );
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

integration("API server on PostgreSQL", () => {
  let db: NodePgDatabase<typeof schema>;
  let pool: Pool;
  const ownerId = `integration-owner-${crypto.randomUUID()}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    db = drizzle(pool, { schema });
    const state = await pool.query<{ sessions: string | null }>(
      "SELECT to_regclass('public.sessions') AS sessions",
    );
    if (state.rows[0]?.sessions === null) {
      await migrate(db, {
        migrationsFolder: `${import.meta.dir}/../../../packages/db/migrations`,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await db.delete(apiKeys).where(eq(apiKeys.ownerId, ownerId));
    await pool.end();
  }, 60_000);

  test(
    "issues one plaintext value, stores its digest, and authenticates HTTP",
    async () => {
      const keyProcess = Bun.spawn(
        ["bun", "run", "src/keys.ts", "create", ownerId],
        {
          cwd: `${import.meta.dir}/..`,
          env: { ...process.env, DATABASE_URL: databaseUrl },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [keyOutput, keyError, keyExit] = await Promise.all([
        new Response(keyProcess.stdout).text(),
        new Response(keyProcess.stderr).text(),
        keyProcess.exited,
      ]);
      expect(keyExit, keyError).toBe(0);
      expect(keyOutput.trim().split("\n")).toHaveLength(1);
      const plaintext = keyOutput.trim();
      expect(plaintext).toStartWith("csp_");

      const [stored] = await db
        .select({ keyHash: apiKeys.keyHash })
        .from(apiKeys)
        .where(eq(apiKeys.ownerId, ownerId));
      expect(stored?.keyHash).toHaveLength(32);
      expect(new TextDecoder().decode(stored?.keyHash)).not.toContain(
        plaintext,
      );

      const port = 40_000 + (process.pid % 20_000);
      const server = Bun.spawn(["bun", "run", "src/server.ts"], {
        cwd: `${import.meta.dir}/..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          DATABASE_URL: databaseUrl,
          PORT: String(port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Drain both pipes from the start so a chatty server never blocks on a
      // full pipe, and so the same text serves the failure message and the
      // leak assertion below.
      const serverStdout = new Response(server.stdout).text();
      const serverStderr = new Response(server.stderr).text();

      try {
        const accepted = await waitForServer(server, serverStderr, {
          url: `http://127.0.0.1:${port}/v1`,
          headers: { Authorization: `Bearer ${plaintext}` },
        });
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({
          status: "ok",
          owner_id: ownerId,
        });

        const rejected = await fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { Authorization: "Bearer wrong" },
        });
        expect(rejected.status).toBe(401);
        const forged = await fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { "X-Owner-Id": "forged-owner" },
        });
        expect(forged.status).toBe(401);
      } finally {
        server.kill("SIGTERM");
        await server.exited;
      }

      const logs = `${await serverStdout}${await serverStderr}`;
      expect(logs).not.toContain(plaintext);
      expect(logs).not.toContain("Authorization");
    },
    TEST_TIMEOUT_MS,
  );
});

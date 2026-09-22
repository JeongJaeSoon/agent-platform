import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import { apiKeys } from "@agent-platform/db";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

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

  test("issues one plaintext value, stores its digest, and authenticates HTTP", async () => {
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
    expect(new TextDecoder().decode(stored?.keyHash)).not.toContain(plaintext);

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

    let accepted: Response | undefined;
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          accepted = await fetch(`http://127.0.0.1:${port}/v1`, {
            headers: { Authorization: `Bearer ${plaintext}` },
          });
          break;
        } catch {
          await Bun.sleep(100);
        }
      }
      expect(accepted?.status).toBe(200);
      expect(await accepted?.json()).toEqual({
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

    const logs = `${await new Response(server.stdout).text()}${await new Response(
      server.stderr,
    ).text()}`;
    expect(logs).not.toContain(plaintext);
    expect(logs).not.toContain("Authorization");
  }, 15_000);
});

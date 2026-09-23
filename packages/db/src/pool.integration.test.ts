import { describe, expect, test } from "bun:test";
import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import { Pool } from "pg";
import { createEnforcedPool } from "./pool.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("enforced pool on PostgreSQL", () => {
  test("no error a read timeout produces carries the client", async () => {
    // statement_timeout high so only the client-side read timeout can fire,
    // as it does when the server is frozen and never answers.
    const pool = createEnforcedPool(databaseUrl ?? "", createLogger(), "job", {
      connectMs: 1_000,
      statementMs: 30_000,
      queryMs: 300,
    });
    try {
      const client = await pool.connect();
      const settle = (text: string) =>
        client
          .query(text)
          .then(() => null)
          .catch((error: unknown) => error);
      // The second one waits behind the first on the same connection.
      const [stuck, queued] = await Promise.all([
        settle("SELECT pg_sleep(5)"),
        settle("SELECT 1"),
      ]);
      // Anything pg-pool's idle listener would stamp lands a tick later.
      await Bun.sleep(100);
      expect(stuck).toMatchObject({ message: "Query read timeout" });
      expect(queued).toBeInstanceOf(Error);
      // A crashed job prints its error with every own property; the client
      // carries the connection password, so it must never ride along.
      for (const failure of [stuck, queued]) {
        expect(Object.keys(failure as object)).not.toContain("client");
      }
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 30_000);

  test("an idle connection the server drops is logged with its reason", async () => {
    const sink = new MemoryLogSink();
    const pool = createEnforcedPool(
      databaseUrl ?? "",
      createLogger({ sinks: [sink] }),
      "job",
      { connectMs: 1_000, statementMs: 1_000, queryMs: 2_000 },
    );
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const pid = (
        await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await Bun.sleep(200);
      const dropped = sink.records.find(
        (record) => record.message === "Pooled database connection dropped",
      );
      expect(dropped?.fields).toMatchObject({ pool: "job", code: "57P01" });
      expect(dropped?.fields?.error).toBeString();
    } finally {
      await pool.end();
      await admin.end();
    }
  }, 30_000);
});

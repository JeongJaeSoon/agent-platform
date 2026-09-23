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

  test("a checked-out connection the server drops fails its holder's next statement, not the process", async () => {
    const pool = createEnforcedPool(databaseUrl ?? "", createLogger(), "job", {
      connectMs: 1_000,
      statementMs: 1_000,
      queryMs: 2_000,
    });
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      // Held between statements, the way a request holds a transaction's
      // client while it awaits something else: pg-pool has taken its idle
      // listener off.
      const client = await pool.connect();
      const pid = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]?.pid;
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await Bun.sleep(200);
      expect(uncaught).toEqual([]);

      const failure = await client.query("SELECT 1").then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      // The API reads these as a storage outage (503); see isStorageUnavailable.
      expect((failure as Error).message).toMatch(
        /^(Client has encountered a connection error|Client was closed and is not queryable|Connection terminated)/,
      );
      expect(Object.keys(failure as object)).not.toContain("client");
      client.release();
      expect(pool.totalCount).toBe(0);
      // The pool hands out a working connection again.
      expect((await pool.query("SELECT 1 AS one")).rows[0]?.one).toBe(1);
    } finally {
      process.off("uncaughtException", onUncaught);
      await pool.end();
      await admin.end();
    }
  }, 30_000);
});

import { describe, expect, test } from "bun:test";
import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import { Pool } from "pg";
import {
  createEnforcedPool,
  RequestDeadline,
  RequestDeadlineExceededError,
  runWithDeadline,
} from "./pool.ts";

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

  // Both timeouts far away, so only the request deadline can end a statement.
  const lenient = { connectMs: 5_000, statementMs: 30_000, queryMs: 30_000 };
  const deadlineIn = (ms: number) =>
    new RequestDeadline(performance.now() + ms);
  const settle = (work: Promise<unknown>) =>
    work.then(
      () => null,
      (error: unknown) => error,
    );

  test("a statement still running at the request deadline is cut off and its client evicted", async () => {
    const pool = createEnforcedPool(
      databaseUrl ?? "",
      createLogger(),
      "api",
      lenient,
    );
    try {
      const client = await pool.connect();
      const started = performance.now();
      const failure = await runWithDeadline(deadlineIn(300), () =>
        client.query("SELECT pg_sleep(5)"),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(failure).toMatchObject({ message: "Query read timeout" });
      await Bun.sleep(50);
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  }, 30_000);

  test("a statement issued after the deadline never reaches the server", async () => {
    const pool = createEnforcedPool(
      databaseUrl ?? "",
      createLogger(),
      "api",
      lenient,
    );
    const table = `deadline_probe_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await pool.query(`CREATE TABLE ${table} (id int)`);
      const deadline = deadlineIn(200);
      const client = await pool.connect();
      await runWithDeadline(deadline, () => client.query("BEGIN"));
      await Bun.sleep(250);
      const failure = await runWithDeadline(deadline, () =>
        client.query(`INSERT INTO ${table} VALUES (1)`),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RequestDeadlineExceededError);
      // The open transaction went with the socket rather than back to the pool.
      await Bun.sleep(50);
      expect(pool.totalCount).toBe(0);
      expect(() => client.release()).not.toThrow();
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      expect(rows).toEqual([{ n: 0 }]);
      // Once the request has answered, the same scope no longer limits anything.
      deadline.finish();
      const after = await runWithDeadline(deadline, () =>
        pool.query("SELECT 1 AS ok"),
      );
      expect(after.rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
      await pool.end();
    }
  }, 30_000);

  test("pool.query waiting for a client keeps its own deadline, not the releaser's", async () => {
    const pool = createEnforcedPool(
      databaseUrl ?? "",
      createLogger(),
      "api",
      lenient,
    );
    // One client, so the second caller queues until the first releases.
    (pool.options as { max: number }).max = 1;
    try {
      const holder = await pool.connect();
      const started = performance.now();
      const waiting = runWithDeadline(deadlineIn(400), () =>
        pool.query("SELECT pg_sleep(5)"),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      await Bun.sleep(50);
      // Released from a context with no deadline at all.
      holder.release();
      const failure = await waiting;
      expect(failure).toMatchObject({ message: "Query read timeout" });
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await pool.end();
    }
  }, 30_000);

  test("a waiter whose deadline passes takes no client, and the one it would have got stays pooled", async () => {
    const pool = createEnforcedPool(
      databaseUrl ?? "",
      createLogger(),
      "api",
      lenient,
    );
    (pool.options as { max: number }).max = 1;
    try {
      const holder = await pool.connect();
      const started = performance.now();
      const failure = await settle(
        runWithDeadline(deadlineIn(200), () => pool.query("SELECT 1")),
      );
      expect(failure).toBeInstanceOf(RequestDeadlineExceededError);
      expect(performance.now() - started).toBeLessThan(1_000);
      holder.release();
      await Bun.sleep(50);
      // Handed to nobody and not destroyed: the healthy connection is idle.
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally {
      await pool.end();
    }
  }, 30_000);

  test("an expired deadline evicts a client idle between two statements of an open transaction", async () => {
    const pool = createEnforcedPool(
      databaseUrl ?? "",
      createLogger(),
      "api",
      lenient,
    );
    const table = `deadline_idle_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await pool.query(`CREATE TABLE ${table} (id int)`);
      const deadline = deadlineIn(10_000);
      const client = await runWithDeadline(deadline, () => pool.connect());
      await runWithDeadline(deadline, async () => {
        await client.query("BEGIN");
        await client.query(`INSERT INTO ${table} VALUES (1)`);
        await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      });
      // The handler now waits on something else and never issues COMMIT.
      deadline.expire();
      await Bun.sleep(100);
      expect(pool.totalCount).toBe(0);
      // The lock and the uncommitted row went with the connection.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      expect(rows).toEqual([{ n: 0 }]);
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
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

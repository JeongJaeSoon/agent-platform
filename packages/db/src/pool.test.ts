import { describe, expect, test } from "bun:test";
import { createLogger } from "@agent-platform/observability";
import {
  createEnforcedPool,
  EvictOnReadTimeoutClient,
  enforcedConfig,
  JOB_POOL_TIMEOUTS,
  RequestDeadline,
} from "./pool.ts";

const url =
  "postgresql://user:secret@db.internal:5433/sessions?statement_timeout=0&query_timeout=0&application_name=api";

describe("pool configuration", () => {
  test("keeps the URL's connection details but not its timeout overrides", () => {
    const config = enforcedConfig(url, {
      connectMs: 1_000,
      statementMs: 2_000,
      queryMs: 4_000,
    });
    expect(config).toMatchObject({
      host: "db.internal",
      port: 5433,
      database: "sessions",
      user: "user",
      password: "secret",
      application_name: "api",
      connectionTimeoutMillis: 1_000,
      statement_timeout: 2_000,
      query_timeout: 4_000,
    });
    expect(config).not.toHaveProperty("connectionString");
  });

  test("a job pool keeps the job limits whatever the URL asks for", () => {
    const pool = createEnforcedPool(
      url,
      createLogger(),
      "scheduler",
      JOB_POOL_TIMEOUTS,
    );
    try {
      expect(pool.options).toMatchObject({
        connectionTimeoutMillis: JOB_POOL_TIMEOUTS.connectMs,
        statement_timeout: JOB_POOL_TIMEOUTS.statementMs,
        query_timeout: JOB_POOL_TIMEOUTS.queryMs,
      });
      expect(pool.listenerCount("error")).toBe(1);
    } finally {
      void pool.end();
    }
  });

  test("a release handle from an earlier checkout cannot release the next one", () => {
    const client = new EvictOnReadTimeoutClient();
    const released: string[] = [];
    // What pg-pool does on each checkout.
    client.release = () => released.push("a");
    const releaseA = client.release;
    releaseA();
    client.release = () => released.push("b");
    const deadline = new RequestDeadline(performance.now() + 60_000);
    let evicted = 0;
    (client as unknown as { evict: () => void }).evict = () => {
      evicted += 1;
    };
    client.holdFor(deadline);
    // A late cleanup from the first holder.
    releaseA();
    releaseA();
    expect(released).toEqual(["a"]);
    // B is still checked out and still held by its deadline.
    deadline.expire();
    expect(evicted).toBe(1);
    client.release();
    client.release();
    expect(released).toEqual(["a", "b"]);
  });
});

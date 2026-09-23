import { describe, expect, test } from "bun:test";
import { createLogger } from "@agent-platform/observability";
import {
  createEnforcedPool,
  enforcedConfig,
  JOB_POOL_TIMEOUTS,
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
});

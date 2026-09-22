import { describe, expect, test } from "bun:test";
import { createLogger } from "@agent-platform/observability";
import { createApiPool, createProbePool, enforcedConfig } from "./pool.ts";

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

  test("both pools carry the enforced limits into pg", () => {
    const logger = createLogger();
    const api = createApiPool(url, logger, {
      connectMs: 1_000,
      statementMs: 2_000,
      queryMs: 4_000,
    });
    const probe = createProbePool(url, logger, 500);
    try {
      expect(api.options).toMatchObject({
        statement_timeout: 2_000,
        query_timeout: 4_000,
        connectionTimeoutMillis: 1_000,
      });
      expect(probe.options).toMatchObject({
        max: 1,
        statement_timeout: 500,
        query_timeout: 1_000,
        connectionTimeoutMillis: 500,
      });
    } finally {
      // Nothing connected; end() just settles the pools.
      void api.end();
      void probe.end();
    }
  });
});

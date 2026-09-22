import type { StructuredLogger } from "@agent-platform/observability";
import { Pool } from "pg";

export interface PoolTimeouts {
  // Waiting for a connection or a free pooled client.
  readonly connectMs: number;
  // Server-side statement_timeout: Postgres cancels the statement itself.
  readonly statementMs: number;
  // Client-side fallback for a socket the server can no longer answer on;
  // later than statementMs so the server cancel is the one that normally
  // fires and the statement does not keep running behind a dead request.
  readonly queryMs: number;
}

// Generous enough for a write that waits on another request's row lock,
// short enough that a frozen database turns into 503s within the window a
// reverse proxy allows (api.md: storage outages are retryable 503s, never
// requests that hang until the client gives up).
export const API_POOL_TIMEOUTS: PoolTimeouts = {
  connectMs: 5_000,
  statementMs: 10_000,
  queryMs: 20_000,
};

export function createApiPool(
  connectionString: string,
  logger: StructuredLogger,
  timeouts: PoolTimeouts = API_POOL_TIMEOUTS,
): Pool {
  return watchIdleErrors(
    new Pool({
      connectionString,
      connectionTimeoutMillis: timeouts.connectMs,
      statement_timeout: timeouts.statementMs,
      query_timeout: timeouts.queryMs,
    }),
    logger,
    "api",
  );
}

// A pool of its own so probe traffic never competes with API requests for
// clients; max 1 caps the work a burst of probes can leave on the server.
export function createProbePool(
  connectionString: string,
  logger: StructuredLogger,
  timeoutMs = 2_000,
): Pool {
  return watchIdleErrors(
    new Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs * 2,
    }),
    logger,
    "probe",
  );
}

// pg-pool emits "error" for an idle client whose backend went away; with no
// listener that is an uncaught exception and the process dies on a database
// restart instead of answering 503 until it is back.
export function watchIdleErrors(
  pool: Pool,
  logger: StructuredLogger,
  name: string,
): Pool {
  pool.on("error", (error) => {
    logger.warn("Idle database connection dropped", {
      pool: name,
      error_name: error.name,
      code: (error as { code?: string }).code ?? null,
    });
  });
  return pool;
}

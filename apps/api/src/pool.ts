import type { StructuredLogger } from "@agent-platform/observability";
import { Client, Pool, type PoolConfig } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";

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

// pg's query_timeout only rejects the caller's promise: the client stays
// busy on a socket the server never answered, so drizzle's ROLLBACK after a
// failed transaction waits another full query_timeout and the client then goes
// back to the pool still poisoned. Dropping the socket the moment the read
// timeout fires fails every queued statement immediately and marks the client
// not queryable, which makes pg-pool discard it on release.
const QUERY_READ_TIMEOUT = "Query read timeout";

export class EvictOnReadTimeoutClient extends Client {
  private pendingRelease: ((error?: Error) => void) | undefined;

  // pg-pool assigns release() on every checkout and throws if it is called
  // twice. Eviction hands the client back itself (drizzle runs BEGIN before
  // the try/finally that releases, so a timed-out BEGIN would otherwise leak
  // the slot for good), and the caller's own release() must then be a no-op.
  set release(fn: ((error?: Error) => void) | undefined) {
    this.pendingRelease = fn;
  }

  get release(): (error?: Error) => void {
    return (error?: Error) => {
      const fn = this.pendingRelease;
      this.pendingRelease = undefined;
      fn?.(error);
    };
  }

  private evictOnReadTimeout(error: unknown): void {
    if (!(error instanceof Error) || error.message !== QUERY_READ_TIMEOUT) {
      return;
    }
    // Killing the socket makes pg emit "error" on this client (once for the
    // socket error, again for the unexpected end). A checked-out client has no
    // listener, so without one the process would die on our own teardown.
    this.on("error", () => {});
    const internals = this as unknown as {
      _queryable?: boolean;
      connection?: { stream?: { destroy(e?: Error): void } };
    };
    // The socket error only lands on the next tick; flag the client unusable
    // now so pg-pool removes it rather than parking it idle for a tick.
    internals._queryable = false;
    internals.connection?.stream?.destroy(error);
    this.release(error);
  }

  // pg's overloads (callback or promise, text or config) all funnel through
  // here; only the failure path is wrapped, so the return shape is unchanged.
  override query(...args: unknown[]): never {
    const last = args[args.length - 1];
    if (typeof last === "function") {
      args[args.length - 1] = (error: unknown, result: unknown) => {
        this.evictOnReadTimeout(error);
        last(error, result);
      };
      return (super.query as (...a: unknown[]) => never)(...args);
    }
    const pending = (super.query as (...a: unknown[]) => unknown)(...args);
    if (pending instanceof Promise) {
      return pending.catch((error: unknown) => {
        this.evictOnReadTimeout(error);
        throw error;
      }) as never;
    }
    return pending as never;
  }
}

export function createApiPool(
  connectionString: string,
  logger: StructuredLogger,
  timeouts: PoolTimeouts = API_POOL_TIMEOUTS,
): Pool {
  return watchIdleErrors(
    new Pool(enforcedConfig(connectionString, timeouts)),
    logger,
    "api",
  );
}

// pg parses connectionString last, so `?statement_timeout=0&query_timeout=0`
// in DATABASE_URL would silently switch the limits off. Parse the URL here
// and lay the limits over it instead.
export function enforcedConfig(
  connectionString: string,
  timeouts: PoolTimeouts,
): PoolConfig {
  return {
    ...parseIntoClientConfig(connectionString),
    Client: EvictOnReadTimeoutClient,
    connectionTimeoutMillis: timeouts.connectMs,
    statement_timeout: timeouts.statementMs,
    query_timeout: timeouts.queryMs,
  };
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
      ...enforcedConfig(connectionString, {
        connectMs: timeoutMs,
        statementMs: timeoutMs,
        queryMs: timeoutMs * 2,
      }),
      max: 1,
    }),
    logger,
    "probe",
  );
}

// pg-pool emits "error" for a pooled client whose socket failed: an idle
// backend that went away, or a client we evicted above whose socket error
// lands after release. With no listener that is an uncaught exception and the
// process dies on a database restart instead of answering 503 until it is back.
export function watchIdleErrors(
  pool: Pool,
  logger: StructuredLogger,
  name: string,
): Pool {
  pool.on("error", (error) => {
    logger.warn("Pooled database connection dropped", {
      pool: name,
      error_name: error.name,
      error_message: error.message,
      code: (error as { code?: string }).code ?? null,
    });
  });
  return pool;
}

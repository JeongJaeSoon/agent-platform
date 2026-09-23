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

// For the one-shot jobs (scheduler, reconciler): the API's numbers. Against
// a frozen database a scheduler pass then waits connectMs + queryMs on the
// statement that fails and queryMs on the pass-lock unlock, about 45s, which
// the compose loop's SCHEDULER_PASS_TIMEOUT_SEC must stay above.
export const JOB_POOL_TIMEOUTS: PoolTimeouts = {
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

  constructor(...args: ConstructorParameters<typeof Client>) {
    super(...args);
    // pg-pool takes its idle listener off at checkout, so a backend that dies
    // while a caller holds the client between statements — a DB restart, an
    // admin kill — would be an uncaught "error" that takes the process down.
    // Nothing is lost by swallowing it: pg marks the client not queryable, the
    // holder's next statement fails with a connection error (503 in the API),
    // and pg-pool discards the client on release. Not logged here: the
    // holder sees the failure, and a pass lock watches for it on its own.
    this.on("error", () => {});
  }

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
    // Flag the client unusable now so pg-pool removes it rather than parking
    // it idle, and so end() takes its destroy-the-socket path instead of
    // asking a server that no longer answers to say goodbye.
    (this as unknown as { _queryable: boolean })._queryable = false;
    // end(), not a bare socket destroy: an ending client fails the queued
    // statements with "Connection terminated" and emits no "error". pg-pool's
    // idle listener stamps any error it sees with `err.client` — password
    // included — and that same object is what the queued callers get, which a
    // job that crashes on it then prints.
    void this.end();
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

export function createEnforcedPool(
  connectionString: string,
  logger: StructuredLogger,
  name: string,
  timeouts: PoolTimeouts,
): Pool {
  return watchIdleErrors(
    new Pool(enforcedConfig(connectionString, timeouts)),
    logger,
    name,
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

// pg-pool emits "error" for a pooled client whose socket failed: an idle
// backend that went away, or a client we evicted above whose socket error
// lands after release. With no listener that is an uncaught exception and the
// process dies on a database restart instead of failing the one request or pass.
export function watchIdleErrors(
  pool: Pool,
  logger: StructuredLogger,
  name: string,
): Pool {
  pool.on("error", (error) => {
    logger.warn("Pooled database connection dropped", {
      pool: name,
      error_name: error.name,
      // Not `error_message`: the logger drops any *message* key as a body.
      error: error.message,
      code: (error as { code?: string }).code ?? null,
    });
  });
  return pool;
}

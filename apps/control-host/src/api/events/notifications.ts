import type { StructuredLogger } from "@agent-platform/observability";
import { Client } from "pg";

// The channel the worker gateway (appendEvents) and PostgresQueue.publish
// raise with the session id as payload, inside the inserting transaction so
// it is delivered on commit.
export const SESSION_EVENTS_CHANNEL = "session_events";

export interface SessionEventWakeup {
  // Settles when a NOTIFY for the session arrives, when the signal aborts, or
  // when the listening connection is (re)established. The last case wakes
  // every waiter on purpose: a notification may have been missed while the
  // channel was down, and the events table is the source of truth, so the
  // caller re-reads. While the channel is down a wait simply stays pending;
  // resolving it at once would turn every idle stream into a hot poll, and
  // the caller's keepalive clock already bounds the wait.
  wait(sessionId: string, signal: AbortSignal): Promise<void>;
}

export interface PostgresSessionNotifierOptions {
  reconnectDelayMs?: number;
  connect?: () => Client;
}

// One dedicated connection, outside the API pool, holds LISTEN for every
// stream in the process; the pool's statement_timeout and query_timeout
// would otherwise cut a connection that by design never answers a query.
export class PostgresSessionNotifier implements SessionEventWakeup {
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #connect: () => Client;
  readonly #reconnectDelayMs: number;
  readonly #logger: StructuredLogger;
  #client: Client | null = null;
  #listening = false;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    connectionString: string,
    logger: StructuredLogger,
    options: PostgresSessionNotifierOptions = {},
  ) {
    this.#logger = logger;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#connect = options.connect ?? (() => new Client({ connectionString }));
  }

  get listening(): boolean {
    return this.#listening;
  }

  // Resolves once the first LISTEN is in place; a lost connection reconnects
  // in the background, so a failed first attempt also resolves and retries.
  async start(): Promise<void> {
    if (this.#closed || this.#client) return;
    const client = this.#connect();
    this.#client = client;
    client.on("notification", (message) => {
      if (message.channel === SESSION_EVENTS_CHANNEL && message.payload) {
        this.#wake(message.payload);
      }
    });
    client.on("error", (error) => this.#lost(client, error));
    client.on("end", () => this.#lost(client, null));
    try {
      await client.connect();
      await client.query(`LISTEN ${SESSION_EVENTS_CHANNEL}`);
      this.#listening = true;
      this.#logger.info("Session event listener connected", {
        channel: SESSION_EVENTS_CHANNEL,
      });
      this.#wakeAll();
    } catch (error) {
      this.#lost(client, error);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    const client = this.#client;
    this.#client = null;
    this.#listening = false;
    this.#wakeAll();
    if (client) {
      client.removeAllListeners("error");
      client.removeAllListeners("end");
      client.on("error", () => {});
      await client.end().catch(() => {});
    }
  }

  wait(sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(sessionId) ?? new Set();
      this.#waiters.set(sessionId, waiters);
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0) this.#waiters.delete(sessionId);
        signal.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #wake(sessionId: string): void {
    const waiters = this.#waiters.get(sessionId);
    if (!waiters) return;
    for (const done of [...waiters]) done();
  }

  #wakeAll(): void {
    for (const sessionId of [...this.#waiters.keys()]) this.#wake(sessionId);
  }

  #lost(client: Client, error: unknown): void {
    // A stale client's events (after a reconnect replaced it) mean nothing.
    if (this.#client !== client) return;
    this.#client = null;
    this.#listening = false;
    client.removeAllListeners();
    client.on("error", () => {});
    void client.end().catch(() => {});
    if (this.#closed) return;
    this.#logger.warn("Session event listener disconnected; reconnecting", {
      error_name: error instanceof Error ? error.name : "ConnectionEnded",
      retry_in_ms: this.#reconnectDelayMs,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.start();
    }, this.#reconnectDelayMs);
  }
}

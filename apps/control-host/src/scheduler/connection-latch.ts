import type { SchedulerStore } from "@agent-platform/platform";

// Node socket errors that mean the database is out of reach.
const SOCKET_ERROR_CODES = new Set([
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

// What pg raises without a code when the socket drops or a pool timeout
// fires (pg/lib/client.js, pg-pool/index.js).
const PG_CONNECTION_MESSAGES =
  /^(Connection terminated|timeout expired|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error|Client was closed and is not queryable)/;

/**
 * The connection is gone, not the statement: 08xxx connection exceptions,
 * 57P0x shutdowns, socket errors and pg's code-less connection failures. Not
 * the API's `isStorageUnavailable`: that one also takes 57014, and a
 * statement_timeout here can be one row waiting on a lock, which the pass
 * treats as that row's failure and moves on from.
 */
export function isConnectionLoss(error: unknown): boolean {
  // Drizzle wraps the driver's error in `cause`.
  for (let depth = 0, current = error; depth < 5; depth += 1) {
    const code = (current as { code?: unknown } | null)?.code;
    if (
      typeof code === "string" &&
      (code.startsWith("08") ||
        code.startsWith("57P") ||
        code.startsWith("ECONN") ||
        SOCKET_ERROR_CODES.has(code))
    ) {
      return true;
    }
    if (!(current instanceof Error)) return false;
    if (PG_CONNECTION_MESSAGES.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

export type ConnectionLatch = {
  store: SchedulerStore;
  /** The failure that tripped the latch, if one did. */
  lost(): unknown;
};

/**
 * Once one store call has lost the connection, every later one fails at once
 * with that same error. The pass reconciles each live execution on its own
 * and carries on past a failure there, so against a frozen database each one
 * would otherwise wait out its own connect timeout and the pass would grow
 * with the number of live rows. The release of the lock `acquirePassLock`
 * returns is left alone: it has to run on the locked connection whatever
 * happened.
 */
export function latchOnConnectionLoss(
  store: SchedulerStore,
  onLost: (error: unknown) => void,
): ConnectionLatch {
  let lost: { error: unknown } | undefined;
  const latched = Object.fromEntries(
    Object.entries(store).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        if (lost !== undefined) throw lost.error;
        try {
          return await (method as (...a: unknown[]) => Promise<unknown>).apply(
            store,
            args,
          );
        } catch (error) {
          if (lost === undefined && isConnectionLoss(error)) {
            lost = { error };
            onLost(error);
          }
          throw error;
        }
      },
    ]),
  ) as unknown as SchedulerStore;
  return { store: latched, lost: () => lost?.error };
}

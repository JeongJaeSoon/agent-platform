import { sql } from "drizzle-orm";
import type { Database } from "./queries.ts";

// The database clock is the one authority on lease, token and launch nonce
// time. Every API replica and the scheduler carry their own clocks, and a
// lagging one would otherwise approve writes for an attempt whose lease
// ended, accept a nonce whose window closed, or refuse a live one early.
export const DB_NOW = sql<Date>`clock_timestamp()`;

export function fromDbNow(ttlMs: number) {
  return sql<Date>`clock_timestamp() + ${ttlMs}::double precision * interval '1 millisecond'`;
}

// Read separately from the locking SELECT: a volatile function in that
// statement's target list can be evaluated before the row lock is granted,
// which would reopen the lock-wait window the fence exists to close.
export async function dbNow(tx: Database): Promise<Date> {
  // As epoch milliseconds: the driver hands raw SQL timestamps back as text.
  const [row] = await tx
    .select({
      epochMs: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
    })
    .from(sql`(SELECT 1) AS one`);
  const epochMs = Number(row?.epochMs);
  if (!Number.isFinite(epochMs)) {
    throw new Error("clock_timestamp() unreadable");
  }
  return new Date(epochMs);
}

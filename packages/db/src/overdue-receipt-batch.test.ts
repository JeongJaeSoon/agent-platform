import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expireOverdueTerminations } from "./control-unit-of-work.ts";
import * as schema from "./schema.ts";
import { controlIntents, receipts, sessions, turns } from "./schema.ts";
import { expireOverdueInterrupts } from "./turn-interrupts.ts";

/**
 * 94S-399: a reconciler back from a long stop finds a backlog of overdue
 * receipts. Each pass flips at most RECONCILER_BATCH_SIZE of them, so the
 * statement stays inside the pass timeout, and the next pass takes the rest.
 */

const LIMIT = 2;
const DEADLINE_MS = 60_000;
const LONG_AGO = new Date(Date.now() - 60 * 60_000);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

afterEach(async () => {
  await client.close();
});

async function acceptedReceipt(operation: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(receipts).values({
    id,
    ownerId: "owner-a",
    operation,
    targetRef: {},
    createdAt: LONG_AGO,
  });
  return id;
}

async function overdueInterrupts(count: number): Promise<void> {
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner-a",
    repoUrl: "https://example.invalid/repo.git",
    branch: `session/${sessionId}`,
  });
  const [turn] = await db
    .insert(turns)
    .values({ sessionId, sequence: 1, message: "m1", status: "running" })
    .returning({ id: turns.id });
  if (!turn) throw new Error("no turn");
  for (let index = 0; index < count; index += 1) {
    await db.insert(controlIntents).values({
      id: crypto.randomUUID(),
      sessionId,
      kind: "interrupt",
      targetTurnId: turn.id,
      attemptId: "attempt-a",
      receiptId: await acceptedReceipt("interrupt"),
      issuedAt: LONG_AGO,
    });
  }
}

async function unknownCount(): Promise<number> {
  return (
    await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(eq(receipts.status, "unknown"))
  ).length;
}

describe("overdue receipt expiry takes one batch per call (94S-399)", () => {
  test("interrupts: limit now, the rest on the next call", async () => {
    await overdueInterrupts(LIMIT + 1);
    const expire = (dryRun: boolean) =>
      expireOverdueInterrupts(db, {
        now: new Date(),
        deadlineMs: DEADLINE_MS,
        dryRun,
        limit: LIMIT,
      });

    expect(await expire(true)).toBe(LIMIT);
    expect(await unknownCount()).toBe(0);
    expect(await expire(false)).toBe(LIMIT);
    expect(await unknownCount()).toBe(LIMIT);
    expect(await expire(false)).toBe(1);
    expect(await unknownCount()).toBe(LIMIT + 1);
    expect(await expire(false)).toBe(0);
  });

  test("terminations: limit now, the rest on the next call", async () => {
    await acceptedReceipt("terminate");
    await acceptedReceipt("revoke_execution");
    await acceptedReceipt("terminate");
    const expire = (dryRun: boolean) =>
      expireOverdueTerminations(db, {
        now: new Date(),
        deadlineMs: DEADLINE_MS,
        dryRun,
        limit: LIMIT,
      });

    expect(await expire(true)).toBe(LIMIT);
    expect(await unknownCount()).toBe(0);
    expect(await expire(false)).toBe(LIMIT);
    expect(await unknownCount()).toBe(LIMIT);
    expect(await expire(false)).toBe(1);
    expect(await unknownCount()).toBe(LIMIT + 1);
    expect(await expire(false)).toBe(0);
  });

  test("terminations without a limit, as the scheduler sweeps, take all", async () => {
    for (let index = 0; index < LIMIT + 1; index += 1) {
      await acceptedReceipt("terminate");
    }
    expect(
      await expireOverdueTerminations(db, {
        now: new Date(),
        deadlineMs: DEADLINE_MS,
      }),
    ).toBe(LIMIT + 1);
  });
});

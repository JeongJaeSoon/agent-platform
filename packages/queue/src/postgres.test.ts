import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import {
  queueMessages,
  sessions,
  unassignedSessions,
} from "@agent-platform/db";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PostgresQueue } from "./postgres.ts";
import { RedisQueueStub } from "./redis.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let queue: PostgresQueue;
let sessionId: string;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: `${import.meta.dir}/../../db/migrations`,
  });
  queue = new PostgresQueue(db);
  sessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner",
    repoUrl: "https://example.invalid/repo.git",
    branch: `session/${sessionId}`,
  });
});

afterEach(async () => {
  await client.close();
});

describe("PostgresQueue", () => {
  test("consumes one session's messages in FIFO order", async () => {
    for (let sequence = 0; sequence < 10; sequence += 1) {
      await queue.enqueue({ sessionId, payload: { message: `${sequence}` } });
    }
    const received: string[] = [];
    for (let sequence = 0; sequence < 10; sequence += 1) {
      const delivery = await queue.consume(sessionId, "consumer");
      if (!delivery || !("message" in delivery.payload)) {
        throw new Error("Expected a session message");
      }
      received.push(delivery.payload.message);
      await delivery.ack();
    }
    expect(received).toEqual(
      Array.from({ length: 10 }, (_, index) => `${index}`),
    );
  });

  test("rejects an invalid payload before storing it", async () => {
    await expect(
      queue.enqueue({
        sessionId,
        payload: { message: "" },
      }),
    ).rejects.toThrow();
    expect(await db.select().from(queueMessages)).toHaveLength(0);
  });

  test("does not deliver one message to two concurrent consumers", async () => {
    for (let sequence = 0; sequence < 10; sequence += 1) {
      await queue.enqueue({ sessionId, payload: { message: `${sequence}` } });
    }
    const deliveries = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        queue.consume(sessionId, `consumer-${index}`),
      ),
    );
    expect(deliveries.filter(Boolean)).toHaveLength(10);
    expect(new Set(deliveries.map((delivery) => delivery?.id)).size).toBe(10);
  });

  test("redelivers an unacknowledged message after its visibility timeout", async () => {
    await queue.enqueue({ sessionId, payload: { message: "retry" } });
    const first = await queue.consume(sessionId, "crashed", 1);
    expect(first).not.toBeNull();
    await Bun.sleep(5);
    const second = await queue.consume(sessionId, "replacement");
    expect(second?.id).toBe(first?.id);
    await second?.ack();
  });

  test("rejects a stale ack after the same consumer reacquires a message", async () => {
    await queue.enqueue({ sessionId, payload: { message: "retry" } });
    const stale = await queue.consume(sessionId, "same-consumer", 1);
    await Bun.sleep(5);
    const current = await queue.consume(sessionId, "same-consumer", 30_000);

    await stale?.ack();
    await stale?.release();
    expect(await db.select().from(queueMessages)).toHaveLength(1);
    await current?.ack();
    expect(await db.select().from(queueMessages)).toHaveLength(0);
  });

  test("replays durable events after an opaque cursor", async () => {
    const first = await queue.publish({
      sessionId,
      event: "status",
      data: { phase: "queued" },
    });
    await queue.publish({
      sessionId,
      event: "status",
      data: { phase: "running" },
    });
    await queue.publish({
      sessionId,
      event: "status",
      data: { phase: "idle" },
    });
    const controller = new AbortController();
    const replayed = [];
    for await (const event of queue.subscribe({
      sessionId,
      after: first.id,
      signal: controller.signal,
      pollIntervalMs: 1,
    })) {
      replayed.push(event);
      if (replayed.length === 2) {
        controller.abort();
      }
    }
    expect(first.id).toStartWith("ev_");
    expect(first.id).not.toContain("-0");
    expect(replayed.map(({ data }) => data)).toEqual([
      { phase: "running" },
      { phase: "idle" },
    ]);
  });

  test("rejects malformed opaque cursors", async () => {
    const subscription = queue.subscribe({ sessionId, after: "ev_1!" });
    await expect(subscription[Symbol.asyncIterator]().next()).rejects.toThrow(
      "Invalid cursor",
    );
  });

  test("manages heartbeat expiry and release", async () => {
    const now = new Date("2026-09-14T00:00:00Z");
    await queue.lease({
      action: "heartbeat",
      podId: "pod-a",
      leaseTtlMs: 1_000,
      now,
    });
    // The deadline the heartbeat stored decides, not a TTL at query time.
    expect(
      await queue.lease({
        action: "expired",
        now: new Date(now.getTime() + 999),
      }),
    ).toEqual({ action: "expired", podIds: [] });
    const expired = await queue.lease({
      action: "expired",
      now: new Date(now.getTime() + 1_001),
    });
    expect(expired).toEqual({ action: "expired", podIds: ["pod-a"] });
    expect(await queue.lease({ action: "release", podId: "pod-a" })).toEqual({
      action: "release",
      released: true,
    });
  });

  test("deduplicates unassigned session signals", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await queue.enqueue({ sessionId, payload: { message: `${attempt}` } });
    }
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
    expect(await db.select().from(queueMessages)).toHaveLength(3);
  });

  test("keeps Redis as an explicit stub", async () => {
    const redis = new RedisQueueStub();
    expect(
      redis.enqueue({ sessionId, payload: { message: "x" } }),
    ).rejects.toThrow("not implemented");
  });
});

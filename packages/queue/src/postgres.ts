import {
  postSessionAnswerRequestSchema,
  sessionEventSchema,
  sessionMessageSchema,
} from "@agent-platform/contracts";
import {
  type Database,
  enqueueWithin,
  events,
  queueMessages,
  sessions,
  workers,
} from "@agent-platform/db";
import { and, asc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  EnqueueInput,
  LeaseCommand,
  LeaseResult,
  PublishInput,
  QueueBackend,
  QueueDelivery,
  QueuePayload,
  SubscribeInput,
} from "./index.ts";

type NotificationWaiter = (signal?: AbortSignal) => Promise<void>;

function encodeCursor(id: number) {
  return `ev_${id.toString(36)}`;
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) {
    return 0;
  }
  if (!/^ev_[0-9a-z]+$/.test(cursor)) {
    throw new Error("Invalid event cursor");
  }
  const id = Number.parseInt(cursor.slice(3), 36);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error("Invalid event cursor");
  }
  return id;
}

function parsePayload(payload: unknown): QueuePayload {
  const answer = postSessionAnswerRequestSchema.safeParse(payload);
  if (answer.success) {
    return answer.data;
  }
  return sessionMessageSchema.parse(payload);
}

function waitForPoll(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export class PostgresQueue implements QueueBackend {
  readonly #db: Database;
  readonly #waitForNotification: NotificationWaiter | undefined;

  constructor(db: Database, waitForNotification?: NotificationWaiter) {
    this.#db = db;
    this.#waitForNotification = waitForNotification;
  }

  async enqueue(input: EnqueueInput) {
    return this.#db.transaction((tx) => enqueueWithin(tx, input));
  }

  async consume(
    sessionId: string,
    consumerId: string,
    visibilityTimeoutMs = 30_000,
  ) {
    const claimed = await this.#db.transaction(async (tx) => {
      const now = new Date();
      const claimToken = crypto.randomUUID();
      const [candidate] = await tx
        .select()
        .from(queueMessages)
        .where(
          and(
            eq(queueMessages.sessionId, sessionId),
            lte(queueMessages.visibleAt, now),
            or(
              isNull(queueMessages.claimedBy),
              lte(queueMessages.visibleAt, now),
            ),
          ),
        )
        .orderBy(asc(queueMessages.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) {
        return null;
      }
      const [updated] = await tx
        .update(queueMessages)
        .set({
          claimedBy: consumerId,
          claimToken,
          visibleAt: new Date(now.getTime() + visibilityTimeoutMs),
        })
        .where(
          and(
            eq(queueMessages.id, candidate.id),
            or(
              isNull(queueMessages.claimedBy),
              lte(queueMessages.visibleAt, now),
            ),
          ),
        )
        .returning();
      return updated ? { ...updated, claimToken } : null;
    });
    if (!claimed) {
      return null;
    }
    return {
      id: claimed.id,
      sessionId: claimed.sessionId,
      turnId: claimed.turnId,
      payload: parsePayload(claimed.payload),
      ack: async () => {
        await this.#db
          .delete(queueMessages)
          .where(
            and(
              eq(queueMessages.id, claimed.id),
              eq(queueMessages.claimedBy, consumerId),
              eq(queueMessages.claimToken, claimed.claimToken),
            ),
          );
      },
      release: async () => {
        await this.#db
          .update(queueMessages)
          .set({ claimToken: null, claimedBy: null, visibleAt: new Date() })
          .where(
            and(
              eq(queueMessages.id, claimed.id),
              eq(queueMessages.claimedBy, consumerId),
              eq(queueMessages.claimToken, claimed.claimToken),
            ),
          );
      },
    } satisfies QueueDelivery;
  }

  async publish(input: PublishInput) {
    const validated = sessionEventSchema.parse({
      id: "ev_0",
      event: input.event,
      data: input.data,
    });
    const [inserted] = await this.#db
      .insert(events)
      .values({
        sessionId: input.sessionId,
        type: validated.event,
        payload: validated.data,
      })
      .returning();
    if (!inserted) {
      throw new Error("Failed to publish event");
    }
    await this.#db.execute(
      sql`SELECT pg_notify('session_events', ${input.sessionId})`,
    );
    return sessionEventSchema.parse({
      id: encodeCursor(inserted.id),
      event: inserted.type,
      data: inserted.payload,
    });
  }

  async *subscribe(input: SubscribeInput) {
    let lastId = decodeCursor(input.after);
    const pollIntervalMs = input.pollIntervalMs ?? 1_000;
    while (!input.signal?.aborted) {
      const rows = await this.#db
        .select()
        .from(events)
        .where(
          and(eq(events.sessionId, input.sessionId), gt(events.id, lastId)),
        )
        .orderBy(asc(events.id))
        .limit(100);
      for (const row of rows) {
        lastId = row.id;
        yield sessionEventSchema.parse({
          id: encodeCursor(row.id),
          event: row.type,
          data: row.payload,
        });
      }
      if (rows.length === 100) {
        continue;
      }
      if (this.#waitForNotification) {
        await this.#waitForNotification(input.signal);
      } else {
        await waitForPoll(pollIntervalMs, input.signal);
      }
    }
  }

  async lease(command: LeaseCommand): Promise<LeaseResult> {
    if (command.action === "heartbeat") {
      await this.#db.transaction(async (tx) => {
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.podId, command.podId))
          .for("update");
        await tx
          .insert(workers)
          .values({ podId: command.podId, lastSeen: command.now ?? new Date() })
          .onConflictDoUpdate({
            target: workers.podId,
            set: { lastSeen: command.now ?? new Date() },
          });
      });
      return { action: "heartbeat", podId: command.podId };
    }
    if (command.action === "release") {
      const deleted = await this.#db
        .delete(workers)
        .where(eq(workers.podId, command.podId))
        .returning({ podId: workers.podId });
      return { action: "release", released: deleted.length === 1 };
    }
    const cutoff = new Date(
      (command.now ?? new Date()).getTime() - command.ttlMs,
    );
    const expired = await this.#db
      .select({ podId: workers.podId })
      .from(workers)
      .where(lt(workers.lastSeen, cutoff));
    return {
      action: "expired",
      podIds: expired.map(({ podId }) => podId),
    };
  }
}

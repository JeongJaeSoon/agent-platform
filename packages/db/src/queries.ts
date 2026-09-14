import type { SessionStatus } from "@claude-session-platform/contracts";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";
import {
  apiKeys,
  queueMessages,
  sessions,
  unassignedSessions,
  workers,
} from "./schema.ts";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

const allowedTransitions: Readonly<
  Record<SessionStatus, readonly SessionStatus[]>
> = {
  queued: ["running"],
  running: ["needs_input", "idle", "failed", "stopped", "queued"],
  needs_input: ["running", "failed", "stopped", "queued"],
  idle: ["running", "stopped", "queued"],
  failed: ["queued"],
  stopped: ["queued"],
};

export async function createApiKey(
  db: Database,
  input: {
    id: string;
    ownerId: string;
    keyHash: Uint8Array;
  },
) {
  const [created] = await db.insert(apiKeys).values(input).returning({
    id: apiKeys.id,
    ownerId: apiKeys.ownerId,
    createdAt: apiKeys.createdAt,
  });
  if (!created) {
    throw new Error("Failed to create API key");
  }
  return created;
}

export async function findApiKeyOwner(
  db: Database,
  keyHash: Uint8Array,
): Promise<string | null> {
  const [match] = await db
    .select({ ownerId: apiKeys.ownerId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  return match?.ownerId ?? null;
}

export async function claim(db: Database, sessionId: string, podId: string) {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(sessions)
      .set({ podId, status: "running", updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.podId)))
      .returning();
    if (!claimed) {
      return null;
    }
    await tx
      .delete(unassignedSessions)
      .where(eq(unassignedSessions.sessionId, sessionId));
    return claimed;
  });
}

export async function release(db: Database, sessionId: string, podId: string) {
  return db.transaction(async (tx) => {
    const [released] = await tx
      .update(sessions)
      .set({ podId: null, updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.podId, podId)))
      .returning();
    if (!released) {
      return null;
    }
    const [pending] = await tx
      .select({ id: queueMessages.id })
      .from(queueMessages)
      .where(eq(queueMessages.sessionId, sessionId))
      .limit(1);
    if (pending) {
      await tx
        .insert(unassignedSessions)
        .values({ sessionId })
        .onConflictDoNothing({ target: unassignedSessions.sessionId });
    }
    return released;
  });
}

export async function transitionSession(
  db: Database,
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
) {
  if (!allowedTransitions[from].includes(to)) {
    throw new Error(`Invalid session status transition: ${from} -> ${to}`);
  }
  const [updated] = await db
    .update(sessions)
    .set({ status: to, updatedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.status, from)))
    .returning();
  return updated ?? null;
}

export async function getSessionForOwner(
  db: Database,
  sessionId: string,
  ownerId: string,
) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
    .limit(1);
  return session ?? null;
}

export async function findOrphanedSessions(
  db: Database,
  leaseTtlMs: number,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - leaseTtlMs);
  return db
    .select({ session: sessions })
    .from(sessions)
    .leftJoin(workers, eq(sessions.podId, workers.podId))
    .where(
      and(
        isNotNull(sessions.podId),
        or(isNull(workers.podId), lt(workers.lastSeen, cutoff)),
      ),
    )
    .then((rows) => rows.map(({ session }) => session));
}

export async function requeueOrphan(
  db: Database,
  sessionId: string,
  stalePodId: string,
) {
  return db.transaction(async (tx) => {
    const [released] = await tx
      .update(sessions)
      .set({ podId: null, status: "queued", updatedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.podId, stalePodId)))
      .returning({ id: sessions.id });
    if (!released) {
      return false;
    }
    await tx
      .insert(unassignedSessions)
      .values({ sessionId })
      .onConflictDoNothing({ target: unassignedSessions.sessionId });
    return true;
  });
}

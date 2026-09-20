import type { SessionStatus, TurnStatus } from "@agent-platform/contracts";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema.ts";
import {
  apiKeys,
  queueMessages,
  sessions,
  turns,
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

const TERMINAL_TURN_STATUSES = new Set<string>([
  "done",
  "failed",
  "interrupted",
] satisfies TurnStatus[]);

export type ReconciledOrphan = {
  action: "blocked" | "released" | "requeued";
  blockedMessageIds: number[];
  dryRun: boolean;
  releasedMessageIds: number[];
  sessionId: string;
  stalePodId: string;
  terminalMessageIds: number[];
};

export async function reconcileOrphanedSessions(
  db: Database,
  options: {
    dryRun?: boolean;
    leaseTtlMs: number;
    limit?: number;
    now?: Date;
  },
): Promise<ReconciledOrphan[]> {
  if (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
    throw new Error("leaseTtlMs must be positive");
  }
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.leaseTtlMs);
  const dryRun = options.dryRun ?? false;

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({
        id: sessions.id,
        podId: sessions.podId,
      })
      .from(sessions)
      .leftJoin(workers, eq(sessions.podId, workers.podId))
      .where(
        and(
          isNotNull(sessions.podId),
          or(isNull(workers.podId), lt(workers.lastSeen, cutoff)),
        ),
      )
      .orderBy(asc(sessions.id))
      .limit(limit)
      .for("update", { of: sessions, skipLocked: true });

    const reconciled: ReconciledOrphan[] = [];
    for (const candidate of candidates) {
      if (candidate.podId === null) continue;
      const stalePodId = candidate.podId;
      const [current] = await tx
        .select({ podId: sessions.podId, status: sessions.status })
        .from(sessions)
        .where(
          and(eq(sessions.id, candidate.id), eq(sessions.podId, stalePodId)),
        )
        .limit(1)
        .for("update");
      if (!current) continue;

      const [lease] = await tx
        .select({ lastSeen: workers.lastSeen })
        .from(workers)
        .where(eq(workers.podId, stalePodId))
        .limit(1)
        .for("update");
      if (lease !== undefined && lease.lastSeen >= cutoff) continue;

      const messages = await tx
        .select({
          claimedBy: queueMessages.claimedBy,
          id: queueMessages.id,
          turnId: queueMessages.turnId,
        })
        .from(queueMessages)
        .where(eq(queueMessages.sessionId, candidate.id))
        .orderBy(asc(queueMessages.id))
        .for("update");
      const turnIds = messages.flatMap(({ turnId }) =>
        turnId === null ? [] : [turnId],
      );
      const turnStatusById = new Map<number, string>();
      if (turnIds.length > 0) {
        const turnRows = await tx
          .select({ id: turns.id, status: turns.status })
          .from(turns)
          .where(inArray(turns.id, turnIds))
          .for("update");
        for (const turn of turnRows) turnStatusById.set(turn.id, turn.status);
      }
      const terminalMessageIds = messages.flatMap((message) =>
        message.turnId !== null &&
        TERMINAL_TURN_STATUSES.has(turnStatusById.get(message.turnId) ?? "")
          ? [message.id]
          : [],
      );
      const retryableMessageIds = messages.flatMap((message) =>
        !terminalMessageIds.includes(message.id) &&
        (message.claimedBy === null ||
          (message.turnId !== null &&
            turnStatusById.get(message.turnId) === "queued"))
          ? [message.id]
          : [],
      );
      const blockedMessageIds = messages.flatMap((message) =>
        terminalMessageIds.includes(message.id) ||
        retryableMessageIds.includes(message.id)
          ? []
          : [message.id],
      );
      const action =
        blockedMessageIds.length > 0
          ? "blocked"
          : retryableMessageIds.length > 0
            ? "requeued"
            : "released";
      const releasedMessageIds =
        action === "requeued" ? retryableMessageIds : [];

      reconciled.push({
        action,
        blockedMessageIds,
        dryRun,
        releasedMessageIds,
        sessionId: candidate.id,
        stalePodId,
        terminalMessageIds,
      });
      if (dryRun) continue;

      if (terminalMessageIds.length > 0) {
        await tx
          .delete(queueMessages)
          .where(inArray(queueMessages.id, terminalMessageIds));
      }
      if (releasedMessageIds.length > 0) {
        await tx
          .update(queueMessages)
          .set({
            claimedBy: null,
            claimToken: null,
            visibleAt: now,
          })
          .where(inArray(queueMessages.id, releasedMessageIds));
      }

      const status =
        action === "requeued"
          ? "queued"
          : current.status === "running" || current.status === "needs_input"
            ? "failed"
            : current.status;
      await tx
        .update(sessions)
        .set({ podId: null, status, updatedAt: now })
        .where(
          and(eq(sessions.id, candidate.id), eq(sessions.podId, stalePodId)),
        );
      if (action === "requeued") {
        await tx
          .insert(unassignedSessions)
          .values({ sessionId: candidate.id, signaledAt: now })
          .onConflictDoNothing({ target: unassignedSessions.sessionId });
      } else {
        await tx
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, candidate.id));
      }
    }
    return reconciled;
  });
}

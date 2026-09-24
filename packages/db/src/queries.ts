import type { SessionScope, TurnStatus } from "@agent-platform/contracts";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { DB_NOW, dbNow } from "./db-clock.ts";
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

export async function createApiKey(
  db: Database,
  input: {
    id: string;
    ownerId: string;
    keyHash: Uint8Array;
    // Null issues the pre-94S-132 all-scope key; only tests still do.
    scopes: readonly SessionScope[] | null;
  },
) {
  const [created] = await db
    .insert(apiKeys)
    .values({
      ...input,
      scopes: input.scopes === null ? null : [...input.scopes],
    })
    .returning({
      id: apiKeys.id,
      ownerId: apiKeys.ownerId,
      createdAt: apiKeys.createdAt,
    });
  if (!created) {
    throw new Error("Failed to create API key");
  }
  return created;
}

export type ApiKeyRecord = {
  id: string;
  ownerId: string;
  workspaceId: string | null;
  // Null on keys issued before scopes existed.
  scopes: SessionScope[] | null;
};

export async function findApiKey(
  db: Database,
  keyHash: Uint8Array,
): Promise<ApiKeyRecord | null> {
  const [match] = await db
    .select({
      id: apiKeys.id,
      ownerId: apiKeys.ownerId,
      workspaceId: apiKeys.workspaceId,
      scopes: apiKeys.scopes,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  // The column's CHECK holds the vocabulary, so the cast only names it.
  return match
    ? { ...match, scopes: match.scopes as SessionScope[] | null }
    : null;
}

export type ApiKeyRevocation =
  | { outcome: "revoked"; ownerId: string; revokedAt: Date }
  | { outcome: "already_revoked"; ownerId: string; revokedAt: Date }
  | { outcome: "not_found" };

/**
 * Revokes one key; a second revoke keeps the first timestamp. Only future
 * authentication is affected: the principal's running work is not
 * cancelled (architecture.md 실행 권한 회수와 API key 회수), and an open SSE
 * stream ends at its next credential re-check.
 */
export async function revokeApiKey(
  db: Database,
  keyId: string,
): Promise<ApiKeyRevocation> {
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: DB_NOW })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ ownerId: apiKeys.ownerId, revokedAt: apiKeys.revokedAt });
  if (revoked?.revokedAt) {
    return {
      outcome: "revoked",
      ownerId: revoked.ownerId,
      revokedAt: revoked.revokedAt,
    };
  }
  const [existing] = await db
    .select({ ownerId: apiKeys.ownerId, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, keyId))
    .limit(1);
  return existing?.revokedAt
    ? {
        outcome: "already_revoked",
        ownerId: existing.ownerId,
        revokedAt: existing.revokedAt,
      }
    : { outcome: "not_found" };
}

// A session bound through the Worker Gateway carries an execution_id and is
// governed by attempts, leases and confirmExecutionGone: clearing its pod_id
// here would let a replacement claim while the execution may still be alive.
// lease-reconcile.ts reconciles those.
const podLifecycleSession = isNull(sessions.executionId);

// outcome_unknown is deliberately not terminal: its input must stay blocked
// until an operator recovery decision.
const TERMINAL_TURN_STATUSES = new Set<string>([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
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
    limit?: number;
    now?: Date;
  },
): Promise<ReconciledOrphan[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  // The heartbeat writer stored each deadline from its own TTL; nothing
  // here knows one (94S-132). Judged on the database clock, like
  // reconcileExpiredLeases, unless a caller pins `now`.
  const pinned = options.now;
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
          podLifecycleSession,
          or(
            isNull(workers.podId),
            lt(workers.leaseExpiresAt, pinned ?? DB_NOW),
          ),
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
        .select({
          partition: sessions.partition,
          podId: sessions.podId,
          status: sessions.status,
        })
        .from(sessions)
        .where(
          and(eq(sessions.id, candidate.id), eq(sessions.podId, stalePodId)),
        )
        .limit(1)
        .for("update");
      if (!current) continue;

      const [lease] = await tx
        .select({ leaseExpiresAt: workers.leaseExpiresAt })
        .from(workers)
        .where(eq(workers.podId, stalePodId))
        .limit(1)
        .for("update");
      // Read after the worker row lock: a heartbeat that held it may have
      // just moved the deadline.
      const at = pinned ?? (await dbNow(tx));
      if (lease !== undefined && lease.leaseExpiresAt >= at) continue;

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
            visibleAt: at,
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
        .set({ podId: null, status, updatedAt: at })
        .where(
          and(eq(sessions.id, candidate.id), eq(sessions.podId, stalePodId)),
        );
      if (action === "requeued") {
        await tx
          .insert(unassignedSessions)
          .values({
            sessionId: candidate.id,
            signaledAt: at,
            partition: current.partition,
          })
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

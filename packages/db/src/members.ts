import { randomUUID } from "node:crypto";
import type { SessionStatus } from "@agent-platform/contracts";
import type {
  MemberStore,
  OffboardResult,
  TakeOverResult,
  TakeoverRecord,
} from "@agent-platform/platform";
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  apiKeys,
  memberships,
  receipts,
  sessions,
  webSessions,
} from "./schema.ts";

const TAKEOVER = "takeover";

async function offboard(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<OffboardResult> {
  const userId = input.userId.toLowerCase();
  return db.transaction(async (tx) => {
    const disabled = await tx
      .update(memberships)
      .set({ disabledAt: DB_NOW })
      .where(
        and(
          eq(memberships.workspaceId, input.workspaceId),
          eq(memberships.userId, userId),
          isNull(memberships.disabledAt),
        ),
      )
      .returning({ userId: memberships.userId });
    if (disabled.length === 0) return { outcome: "not_found" };
    // Every web session, not only this workspace's: a cookie resolves to
    // whichever live membership is oldest, so one left alive could keep
    // working under another (design D16).
    const sessionsRevoked = await tx
      .update(webSessions)
      .set({ revokedAt: DB_NOW })
      .where(and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt)))
      .returning({ id: webSessions.id });
    // Revoked rather than left to the creator check, so restoring the
    // membership later does not bring them back. Service keys the person
    // issued belong to the workspace and keep working.
    const keysRevoked = await tx
      .update(apiKeys)
      .set({ revokedAt: DB_NOW })
      .where(
        and(
          eq(apiKeys.kind, "personal"),
          eq(apiKeys.createdByUserId, userId),
          eq(apiKeys.workspaceId, input.workspaceId),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });
    const awaiting = await tx
      .update(sessions)
      .set({ takeoverRequiredAt: DB_NOW, updatedAt: new Date() })
      .where(
        and(
          eq(sessions.workspaceId, input.workspaceId),
          eq(sessions.createdByUserId, userId),
          ne(sessions.admissionState, "closed"),
          isNull(sessions.takeoverRequiredAt),
        ),
      )
      .returning({ id: sessions.id });
    return {
      outcome: "offboarded",
      revokedWebSessions: sessionsRevoked.length,
      revokedPersonalKeys: keysRevoked.length,
      sessionsAwaitingTakeover: awaiting.length,
    };
  });
}

export function createPostgresMemberStore(db: Database): MemberStore {
  return {
    offboard: (input) => offboard(db, input),

    async listAwaitingTakeover(
      workspaceId: string,
      limit: number,
    ): Promise<TakeoverRecord[]> {
      const rows = await db
        .select({
          sessionId: sessions.id,
          departedUserId: sessions.createdByUserId,
          status: sessions.status,
          createdAt: sessions.createdAt,
          takeoverRequiredAt: sessions.takeoverRequiredAt,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.workspaceId, workspaceId),
            isNotNull(sessions.takeoverRequiredAt),
            ne(sessions.admissionState, "closed"),
          ),
        )
        .orderBy(asc(sessions.takeoverRequiredAt), asc(sessions.id))
        .limit(limit);
      return rows.flatMap((row) =>
        row.departedUserId === null || row.takeoverRequiredAt === null
          ? []
          : [
              {
                sessionId: row.sessionId,
                departedUserId: row.departedUserId,
                status: row.status as SessionStatus,
                createdAt: row.createdAt,
                takeoverRequiredAt: row.takeoverRequiredAt,
              },
            ],
      );
    },

    takeOver(input): Promise<TakeOverResult> {
      const sessionId = input.sessionId.toLowerCase();
      return db.transaction(async (tx) => {
        const [session] = await tx
          .select({ takeoverRequiredAt: sessions.takeoverRequiredAt })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.principal.ownerId),
              eq(sessions.workspaceId, input.workspaceId),
            ),
          )
          .limit(1)
          .for("update");
        if (!session) return { outcome: "not_found" };
        if (session.takeoverRequiredAt === null) {
          return { outcome: "not_awaiting" };
        }
        await tx
          .update(sessions)
          .set({
            createdByUserId: input.newRequesterId,
            takeoverRequiredAt: null,
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, sessionId));
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: TAKEOVER,
          targetRef: { session_id: sessionId, turn_id: null, request_id: null },
          status: "succeeded",
        });
        return { outcome: "taken_over", receiptId };
      });
    },
  };
}

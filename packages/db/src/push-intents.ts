import { randomUUID } from "node:crypto";
import type { PushIntent, PushIntentRefusal } from "@werft-ai/contracts";
import type { PushIntentStore } from "@werft-ai/platform";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { pushIntents, sessions, turns } from "./schema.ts";

type Row = typeof pushIntents.$inferSelect;

export function publicPushIntent(row: Row): PushIntent {
  return {
    id: row.id,
    session_id: row.sessionId,
    repository_id: row.repositoryId,
    target_branch: row.targetBranch,
    status: row.status as PushIntent["status"],
    refusal_code: row.refusalCode as PushIntentRefusal | null,
    push_request_id: row.pushRequestId,
    created_at: row.createdAt.toISOString(),
  };
}

export function createPostgresPushIntents(db: Database): PushIntentStore {
  return {
    createDeferred(input) {
      const sessionId = input.sessionId.toLowerCase();
      return db.transaction(async (tx) => {
        // Session row first: finalize holds it while it pins or cancels this
        // turn's intents, so a create either lands before it (and is pinned
        // with the rest) or finds the turn no longer running.
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, input.ownerId),
            ),
          )
          .limit(1)
          .for("update");
        if (session === undefined) return { outcome: "turn_not_running" };
        const [turn] = await tx
          .select({ id: turns.id })
          .from(turns)
          .where(
            and(
              eq(turns.id, input.turnId),
              eq(turns.sessionId, sessionId),
              eq(turns.attemptId, input.attemptId),
              eq(turns.status, "running"),
            ),
          )
          .limit(1);
        if (turn === undefined) return { outcome: "turn_not_running" };
        const [existing] = await tx
          .select()
          .from(pushIntents)
          .where(
            and(
              eq(pushIntents.turnId, input.turnId),
              eq(pushIntents.repositoryId, input.repositoryId),
              eq(pushIntents.targetBranch, input.targetBranch),
            ),
          )
          .limit(1);
        if (existing) {
          return { outcome: "existing", intent: publicPushIntent(existing) };
        }
        const [row] = await tx
          .insert(pushIntents)
          .values({
            id: randomUUID(),
            ownerId: input.ownerId,
            sessionId,
            turnId: input.turnId,
            attemptId: input.attemptId,
            repositoryId: input.repositoryId,
            targetBranch: input.targetBranch,
            actor: input.actor,
            approvalBasis: input.pushClass,
            policySource: input.policySource,
            pullRequest: input.pullRequest ?? null,
          })
          .returning();
        if (!row) throw new Error("push intent insert returned no row");
        return { outcome: "created", intent: publicPushIntent(row) };
      });
    },

    async list(ownerId, sessionId) {
      const rows = await db
        .select()
        .from(pushIntents)
        .where(
          and(
            eq(pushIntents.sessionId, sessionId.toLowerCase()),
            eq(pushIntents.ownerId, ownerId),
          ),
        )
        .orderBy(desc(pushIntents.createdAt), desc(pushIntents.id));
      return rows.map(publicPushIntent);
    },
  };
}

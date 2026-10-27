import type { SessionTitleStore } from "@werft-ai/platform";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  lockSessionForControl,
  transactionWithBindingRetry,
} from "./control-shared.ts";
import { DB_NOW, dbNow, fromDbNow } from "./db-clock.ts";
import { awaitingInputAt, publicStatus } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { sessions, sessionTitleRequests, turns } from "./schema.ts";
import { recordStatus } from "./session-events.ts";

export function createPostgresSessionTitleStore(
  db: Database,
): SessionTitleStore {
  return {
    issueAtomic(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            titleSource: sessions.titleSource,
            authRevision: sessions.authRevision,
            profileId: sessions.profileId,
            profileFingerprint: sessions.profileFingerprint,
            model: sessions.model,
            message: turns.message,
            status: turns.status,
            resultJson: turns.resultJson,
            attemptId: turns.attemptId,
          })
          .from(sessions)
          .innerJoin(
            turns,
            and(eq(turns.sessionId, sessions.id), eq(turns.sequence, 1)),
          )
          .where(eq(sessions.id, input.sessionId))
          .limit(1);
        if (
          !row ||
          row.titleSource !== "derived" ||
          row.status !== "completed" ||
          row.attemptId !== input.attemptId
        ) {
          return { outcome: "skipped" };
        }
        const inserted = await tx
          .insert(sessionTitleRequests)
          .values({
            sessionId: input.sessionId,
            attemptId: input.attemptId,
            tokenHash: input.tokenHash,
            authRevision: row.authRevision,
            expiresAt: fromDbNow(input.ttlMs),
          })
          .onConflictDoNothing({ target: sessionTitleRequests.sessionId })
          .returning({ sessionId: sessionTitleRequests.sessionId });
        if (inserted.length === 0) return { outcome: "skipped" };
        return {
          outcome: "issued",
          message: row.message,
          result: resultTextOf(row.resultJson),
          profileId: row.profileId,
          profileFingerprint: row.profileFingerprint,
          model: row.model,
        };
      });
    },

    async authorizeAtomic(input) {
      const [row] = await db
        .select({
          sessionId: sessionTitleRequests.sessionId,
          attemptId: sessionTitleRequests.attemptId,
          issuedRevision: sessionTitleRequests.authRevision,
          authRevision: sessions.authRevision,
          executionRevokedAt: sessions.executionRevokedAt,
          profileId: sessions.profileId,
          profileFingerprint: sessions.profileFingerprint,
          model: sessions.model,
          costUsd: sessions.costUsd,
          providerTokens: sessions.providerTokens,
        })
        .from(sessionTitleRequests)
        .innerJoin(sessions, eq(sessions.id, sessionTitleRequests.sessionId))
        .where(
          and(
            eq(sessionTitleRequests.tokenHash, input.tokenHash),
            isNull(sessionTitleRequests.settledAt),
            gt(sessionTitleRequests.expiresAt, DB_NOW),
          ),
        )
        .limit(1);
      if (
        !row ||
        row.issuedRevision !== row.authRevision ||
        row.executionRevokedAt !== null
      ) {
        return { outcome: "invalid_token" };
      }
      return {
        outcome: "ok",
        sessionId: row.sessionId,
        attemptId: row.attemptId,
        profileId: row.profileId,
        profileFingerprint: row.profileFingerprint,
        model: row.model,
        costUsd: row.costUsd,
        providerTokens: row.providerTokens,
      };
    },

    settleAtomic(input) {
      return transactionWithBindingRetry(db, async (tx, attempt) => {
        const [request] = await tx
          .select({
            sessionId: sessionTitleRequests.sessionId,
            settledAt: sessionTitleRequests.settledAt,
          })
          .from(sessionTitleRequests)
          .where(eq(sessionTitleRequests.tokenHash, input.tokenHash))
          .limit(1)
          .for("update");
        if (!request || request.settledAt !== null) return { outcome: "kept" };
        await tx
          .update(sessionTitleRequests)
          .set({ settledAt: input.now })
          .where(eq(sessionTitleRequests.sessionId, request.sessionId));
        if (input.title === null) return { outcome: "kept" };
        // The events writer's lock, as a rename takes it: whichever of the
        // two commits second sees the other's title_source.
        const session = await lockSessionForControl(tx, {
          sessionId: request.sessionId,
          attempt,
        });
        if (!session || session.titleSource !== "derived") {
          return { outcome: "kept" };
        }
        await tx
          .update(sessions)
          .set({
            title: input.title,
            titleSource: "generated",
            updatedAt: input.now,
          })
          .where(eq(sessions.id, request.sessionId));
        if (session.title !== input.title) {
          const at = await dbNow(tx);
          await recordStatus(tx, {
            sessionId: request.sessionId,
            phase: publicStatus(
              session.status,
              await awaitingInputAt(tx, request.sessionId, at),
            ),
            extra: {
              admission_state: session.admissionState,
              title: input.title,
            },
            turnRowId: null,
            now: input.now,
          });
        }
        return { outcome: "applied" };
      });
    },
  };
}

function resultTextOf(resultJson: unknown): string | null {
  if (typeof resultJson !== "object" || resultJson === null) return null;
  const { result } = resultJson as { result?: unknown };
  return typeof result === "string" ? result : null;
}

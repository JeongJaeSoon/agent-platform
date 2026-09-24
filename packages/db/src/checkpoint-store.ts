import type {
  CheckpointCollectionFences,
  CheckpointCollectionStore,
  CheckpointPointer,
  CheckpointStore,
  CommitCheckpointInput,
  CommitCheckpointResult,
} from "@agent-platform/platform";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lt,
  lte,
  notInArray,
} from "drizzle-orm";
import { ENDED_ATTEMPT_STATES } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import { attempts, checkpoints, sessions, turns } from "./schema.ts";
import {
  acquireFence,
  advanceCheckpointPointer,
  readCheckpointPointer,
} from "./worker-unit-of-work.ts";

/**
 * The checkpoint pointer on PostgreSQL. Reads and turn-less commits share the
 * helpers a turn's finalize uses (worker-unit-of-work.ts), so both entry
 * points judge the fence, the clock and the next revision the same way.
 */
export function createPostgresCheckpointStore(
  db: Database,
): CheckpointStore & CheckpointCollectionStore {
  return {
    /**
     * The fence judged the way `acquireFence` judges it, for every attempt
     * at once, from one snapshot of the session row and its attempts. A
     * lease that merely ran out is not a lost fence: the attempt may yet
     * heartbeat before the reconciler ends it.
     */
    readCollectionFences(
      sessionId: string,
    ): Promise<CheckpointCollectionFences | null> {
      return db.transaction(
        async (tx) => {
          const [session] = await tx
            .select({
              authRevision: sessions.authRevision,
              executionGeneration: sessions.executionGeneration,
              fallbackRevision: sessions.checkpointFallbackRevision,
              leaseEpoch: sessions.leaseEpoch,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (!session) return null;
          const rows = await tx
            .select({
              authRevision: attempts.authRevision,
              executionGeneration: attempts.executionGeneration,
              id: attempts.id,
              leaseEpoch: attempts.leaseEpoch,
              state: attempts.state,
            })
            .from(attempts)
            .where(eq(attempts.sessionId, sessionId));
          const fenced = rows.filter(
            (attempt) =>
              ENDED_ATTEMPT_STATES.includes(attempt.state) ||
              attempt.leaseEpoch !== session.leaseEpoch ||
              attempt.executionGeneration !== session.executionGeneration ||
              attempt.authRevision !== session.authRevision,
          );
          return {
            executionGeneration: session.executionGeneration,
            fallbackRevision: session.fallbackRevision,
            fencedAttemptIds: new Set(fenced.map((attempt) => attempt.id)),
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async markCollected(
      sessionId: string,
      options: { keep: readonly number[]; throughRevision: number },
    ): Promise<number> {
      const marked = await db
        .update(checkpoints)
        .set({ collectedAt: DB_NOW })
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            lte(checkpoints.revision, options.throughRevision),
            isNull(checkpoints.collectedAt),
            ...(options.keep.length === 0
              ? []
              : [notInArray(checkpoints.revision, [...options.keep])]),
          ),
        )
        .returning({ revision: checkpoints.revision });
      return marked.length;
    },

    async listSessionIds(options: {
      after: string | null;
      limit: number;
    }): Promise<string[]> {
      const rows = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          options.after === null ? undefined : gt(sessions.id, options.after),
        )
        .orderBy(asc(sessions.id))
        .limit(options.limit);
      return rows.map((row) => row.id);
    },

    readPointer(sessionId: string): Promise<CheckpointPointer | null> {
      // One transaction, so the row and the checkpoint it names are read
      // from a single snapshot.
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            id: sessions.id,
            checkpointRevision: sessions.checkpointRevision,
            checkpointCommittedAt: sessions.checkpointCommittedAt,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        return row ? readCheckpointPointer(tx, row) : null;
      });
    },

    async listCheckpoints(
      sessionId: string,
      options: { belowRevision: number; limit: number },
    ): Promise<CheckpointPointer[]> {
      if (options.limit <= 0) return [];
      // Rows are only ever inserted, together with the pointer advance, so
      // everything below a pointer the caller already read is settled.
      const rows = await db
        .select({
          revision: checkpoints.revision,
          manifestRef: checkpoints.manifestRef,
          manifestSha256: checkpoints.manifestSha256,
          manifestVersion: checkpoints.manifestVersion,
          versionsHeld: checkpoints.versionsHeld,
          parentRevision: checkpoints.parentRevision,
          committedAt: checkpoints.committedAt,
          turnSequence: turns.sequence,
        })
        .from(checkpoints)
        .leftJoin(turns, eq(turns.id, checkpoints.turnId))
        .where(
          and(
            eq(checkpoints.sessionId, sessionId),
            lt(checkpoints.revision, options.belowRevision),
          ),
        )
        .orderBy(desc(checkpoints.revision))
        .limit(options.limit);
      return rows.map((row) => ({
        committedAt: row.committedAt,
        manifestRef: row.manifestRef,
        manifestSha256: row.manifestSha256,
        manifestVersion: row.manifestVersion,
        parentRevision: row.parentRevision,
        revision: row.revision,
        versionsHeld: row.versionsHeld,
        turnId: row.turnSequence === null ? null : String(row.turnSequence),
      }));
    },

    /**
     * A pointer commit with no turn to close: the same fenced pointer advance
     * a turn's finalize performs, on its own. The turn path never comes here
     * (finalizeAtomic owns it); this is what a drain or pause commits with.
     */
    commitAtomic(
      input: CommitCheckpointInput,
    ): Promise<CommitCheckpointResult> {
      const fence = {
        sessionId: input.fence.sessionId,
        attemptId: input.fence.attemptId,
        leaseEpoch: input.fence.leaseEpoch,
        executionGeneration: input.fence.executionGeneration,
        authRevision: input.fence.authRevision,
      };
      // A turn's checkpoint commits with its terminal in finalizeAtomic;
      // attaching one here would bypass that turn's ownership and replay
      // rules, so a turn id is refused rather than looked up.
      if (input.turnId !== null) {
        return Promise.reject(
          new Error(
            "createPostgresCheckpointStore commits turn-less checkpoints only; a turn's checkpoint goes through finalizeAtomic",
          ),
        );
      }
      return db.transaction(async (tx) => {
        if (input.sessionId !== fence.sessionId)
          return { outcome: "stale_epoch" };
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const advanced = await advanceCheckpointPointer(tx, {
          fence,
          session: fenced.session,
          checkpoint: input.checkpoint,
          turnRowId: null,
          now: input.now,
          versionsHeld: input.versionsHeld === true,
        });
        if (advanced.outcome === "committed") {
          return { outcome: "committed", revision: advanced.revision };
        }
        // The same manifest already stands at this revision: a retry of a
        // commit whose answer was lost, not a competing checkpoint. The
        // version counts too — identical bytes stored twice are two objects,
        // and only the one this pointer names was verified and held.
        const [stored] = await tx
          .select({
            manifestRef: checkpoints.manifestRef,
            manifestSha256: checkpoints.manifestSha256,
            manifestVersion: checkpoints.manifestVersion,
          })
          .from(checkpoints)
          .where(
            and(
              eq(checkpoints.sessionId, fence.sessionId),
              eq(checkpoints.revision, input.checkpoint.revision),
            ),
          )
          .limit(1);
        if (
          stored &&
          stored.manifestRef === input.checkpoint.manifest_ref &&
          stored.manifestSha256 === input.checkpoint.manifest_sha256 &&
          stored.manifestVersion === (input.checkpoint.manifest_version ?? null)
        ) {
          return { outcome: "replayed", revision: input.checkpoint.revision };
        }
        return {
          outcome: "conflict",
          currentRevision: advanced.currentRevision,
        };
      });
    },
  };
}

import type {
  CheckpointPointer,
  CheckpointStore,
  CommitCheckpointInput,
  CommitCheckpointResult,
} from "@agent-platform/platform";
import { and, eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { checkpoints, sessions, turns } from "./schema.ts";
import {
  acquireFence,
  advanceCheckpointPointer,
  readCheckpointPointer,
} from "./worker-unit-of-work.ts";

const TURN_ID = /^[1-9]\d{0,9}$/;

/**
 * The checkpoint pointer on PostgreSQL. Reads and turn-less commits share the
 * helpers a turn's finalize uses (worker-unit-of-work.ts), so both entry
 * points judge the fence, the clock and the next revision the same way.
 */
export function createPostgresCheckpointStore(db: Database): CheckpointStore {
  return {
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
      return db.transaction(async (tx) => {
        if (input.sessionId !== fence.sessionId)
          return { outcome: "stale_epoch" };
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        let turnRowId: number | null = null;
        if (input.turnId !== null) {
          if (!TURN_ID.test(input.turnId)) return { outcome: "stale_epoch" };
          const [turn] = await tx
            .select({ id: turns.id })
            .from(turns)
            .where(
              and(
                eq(turns.sessionId, fence.sessionId),
                eq(turns.sequence, Number(input.turnId)),
              ),
            )
            .limit(1);
          turnRowId = turn?.id ?? null;
        }
        const advanced = await advanceCheckpointPointer(tx, {
          fence,
          session: fenced.session,
          checkpoint: input.checkpoint,
          turnRowId,
          now: input.now,
        });
        if (advanced.outcome === "committed") {
          return { outcome: "committed", revision: advanced.revision };
        }
        // The same manifest already stands at this revision: a retry of a
        // commit whose answer was lost, not a competing checkpoint.
        const [stored] = await tx
          .select({
            manifestRef: checkpoints.manifestRef,
            manifestSha256: checkpoints.manifestSha256,
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
          stored.manifestSha256 === input.checkpoint.manifest_sha256
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

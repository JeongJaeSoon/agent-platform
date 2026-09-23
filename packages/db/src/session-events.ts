import {
  type SessionEventName,
  type StatusEventPhase,
  sessionEventPayloadSchema,
} from "@agent-platform/contracts";
import { and, eq, notExists, sql } from "drizzle-orm";
import { dbNow } from "./db-clock.ts";
import {
  actionableOfSession,
  awaitingInputAt,
  publicStatus,
} from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { events, sessions } from "./schema.ts";

// A server-side write to the session's event stream. The caller holds the
// session row FOR UPDATE, as every events writer must (94S-126): ids are
// taken at insert, so two writers racing without it could commit out of the
// order readers see. Like every other writer, it holds the payload to the
// public event contract before storing it: the reader parses each row with
// the same schema, and a row it cannot parse is lost to every client
// (94S-283).
export async function recordEvent(
  tx: Database,
  input: {
    sessionId: string;
    type: SessionEventName;
    payload: Record<string, unknown>;
    turnRowId: number | null;
    attemptId?: string;
    now: Date;
  },
) {
  const checked = sessionEventPayloadSchema.parse({
    event: input.type,
    data: input.payload,
  });
  await tx.insert(events).values({
    sessionId: input.sessionId,
    type: checked.event,
    payload: checked.data,
    turnId: input.turnRowId,
    // No source_sequence: that numbering is the worker's own stream.
    attemptId: input.attemptId ?? null,
    occurredAt: input.now,
  });
  await tx.execute(sql`SELECT pg_notify('session_events', ${input.sessionId})`);
}

/**
 * A status event from the control plane. It also records whether the stream
 * now says the session is waiting for input, which is what later writes and
 * the reconciler compare against to announce the end of that wait once.
 */
export async function recordStatus(
  tx: Database,
  input: {
    sessionId: string;
    phase: StatusEventPhase;
    extra?: Record<string, unknown>;
    turnRowId: number | null;
    now: Date;
  },
) {
  await recordEvent(tx, {
    sessionId: input.sessionId,
    type: "status",
    payload: { phase: input.phase, ...input.extra },
    turnRowId: input.turnRowId,
    now: input.now,
  });
  await tx
    .update(sessions)
    .set({ inputAnnounced: input.phase === "needs_input" })
    .where(eq(sessions.id, input.sessionId));
}

/**
 * Read before a write that can close requests: true when the stream says
 * the session is waiting and it still is at `at`. Only a wait both
 * announced and real is one whose end this write may announce; a wait that
 * already lapsed with no write is the reconciler's to report.
 */
export async function inputWaitBefore(
  tx: Database,
  session: { id: string; inputAnnounced: boolean },
  at: Date,
): Promise<boolean> {
  return session.inputAnnounced && (await awaitingInputAt(tx, session.id, at));
}

/**
 * After that write, at the same instant: if the wait ended here, say so
 * once with the status the session now reads as.
 */
export async function announceInputWaitEnded(
  tx: Database,
  input: {
    sessionId: string;
    waitingBefore: boolean;
    turnRowId: number | null;
    at: Date;
  },
) {
  if (!input.waitingBefore) return;
  if (await awaitingInputAt(tx, input.sessionId, input.at)) return;
  const [session] = await tx
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  if (!session) return;
  await recordStatus(tx, {
    sessionId: input.sessionId,
    phase: publicStatus(session.status, false),
    turnRowId: input.turnRowId,
    now: input.at,
  });
}

export type AnnouncedInputReturn = { sessionId: string; phase: string };

/**
 * Waits that ended with nothing written: a request expired, or the attempt
 * that asked lost the session, or a close or a gone execution closed the
 * requests along with the session's own status. The stream still says
 * needs_input; this says what the session reads as now. Judged again under
 * the session lock, on the database clock, so a wait an answer or a new
 * question already reported is left alone.
 */
export async function announceLapsedInputWaits(
  db: Database,
  options: { limit: number; dryRun: boolean },
): Promise<AnnouncedInputReturn[]> {
  const candidates = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.inputAnnounced, true),
        notExists(actionableOfSession(db)),
      ),
    )
    .limit(options.limit);
  const announced: AnnouncedInputReturn[] = [];
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          id: sessions.id,
          status: sessions.status,
          inputAnnounced: sessions.inputAnnounced,
        })
        .from(sessions)
        .where(eq(sessions.id, candidate.id))
        .limit(1)
        .for("update");
      if (!session?.inputAnnounced) return null;
      const at = await dbNow(tx);
      if (await awaitingInputAt(tx, session.id, at)) return null;
      const phase = publicStatus(session.status, false);
      if (!options.dryRun) {
        await recordStatus(tx, {
          sessionId: session.id,
          phase,
          turnRowId: null,
          now: at,
        });
      }
      return { sessionId: session.id, phase };
    });
    if (result !== null) announced.push(result);
  }
  return announced;
}

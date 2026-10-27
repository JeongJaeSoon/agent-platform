import type { SessionEventPayload } from "@werft-ai/contracts";
import type { NeutralizeEvent } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";
import { TOOL_CALL_CURSOR_MARGIN_SECONDS } from "./tool-calls.ts";

// pg_try_advisory_xact_lock key: one replica fills a batch at a time; the
// others find it taken and leave the pass to it.
export const NEUTRAL_FILL_LOCK_KEY = 6_600_660;
// The event kinds a runtime's adapter writes; the rest are the platform's.
const ENGINE_EVENT_TYPES = [
  "assistant",
  "tool_use",
  "tool_result",
  "result",
  "system",
] as const;

export type NeutralFill = {
  eventsRead: number;
  /** Events that got fields they lacked. */
  filled: number;
  batches: number;
  filledThrough: number;
  /** Nothing left to read beyond the margin when the pass stopped. */
  caughtUp: boolean;
  /** Another replica held the fill; this pass did nothing. */
  busy: boolean;
};

/**
 * Adds the engine-neutral fields to stored events that lack them, from the
 * progress cursor on, until it catches up or `budgetMs` runs out. Only keys
 * an event lacks are added and nothing stored is rewritten, so a batch read
 * twice changes nothing more. The cursor passes rows as `projectToolCalls`
 * does (TOOL_CALL_CURSOR_MARGIN_SECONDS).
 */
export async function fillNeutralFields(
  db: Database,
  options: {
    neutralize: NeutralizeEvent;
    batchSize: number;
    budgetMs: number;
    marginSeconds?: number;
    now?: () => number;
  },
): Promise<NeutralFill> {
  const now = options.now ?? Date.now;
  const margin = options.marginSeconds ?? TOOL_CALL_CURSOR_MARGIN_SECONDS;
  const started = now();
  const pass: NeutralFill = {
    eventsRead: 0,
    filled: 0,
    batches: 0,
    filledThrough: 0,
    caughtUp: false,
    busy: false,
  };
  let read: number | null = null;
  while (
    !pass.caughtUp &&
    (pass.batches === 0 || now() - started < options.budgetMs)
  ) {
    const batch = await fillBatch(db, options, read, margin);
    if (batch === null) return { ...pass, busy: true };
    read = batch.hi;
    pass.eventsRead += batch.n;
    pass.filled += batch.filled;
    pass.batches += 1;
    pass.filledThrough = batch.cursor;
    pass.caughtUp = batch.n < options.batchSize;
  }
  return pass;
}

type BatchRow = {
  id: string;
  type: string;
  payload: unknown;
  safe: boolean;
  profile_id: string | null;
};

function fillBatch(
  db: Database,
  options: { neutralize: NeutralizeEvent; batchSize: number },
  read: number | null,
  margin: number,
) {
  return db.transaction(async (tx) => {
    const [lock] = rowsOf<{ locked: boolean }>(
      await tx.execute(
        sql`SELECT pg_try_advisory_xact_lock(${NEUTRAL_FILL_LOCK_KEY}) AS locked`,
      ),
    );
    if (!lock?.locked) return null;
    const [progress] = rowsOf<{ filled_through: string }>(
      await tx.execute(
        sql`SELECT filled_through FROM neutral_field_progress WHERE id = 1 FOR UPDATE`,
      ),
    );
    if (!progress) throw new Error("neutral_field_progress has no row");
    const cursor = Number(progress.filled_through);
    const from = read === null ? cursor : Math.max(read, cursor);
    const rows = rowsOf<BatchRow>(
      await tx.execute(sql`
        SELECT b.id, b.type, b.payload, b.safe, s.profile_id
        FROM (
          SELECT id, session_id, type,
            CASE WHEN type IN (${sql.join(
              ENGINE_EVENT_TYPES.map((type) => sql`${type}`),
              sql`, `,
            )}) THEN payload END AS payload,
            created_at < now() - make_interval(secs => ${margin}) AS safe
          FROM events WHERE id > ${from} ORDER BY id LIMIT ${options.batchSize}
        ) AS b
        JOIN sessions s ON s.id = b.session_id
        ORDER BY b.id`),
    );
    if (rows.length === 0) return { n: 0, filled: 0, hi: from, cursor };
    const added = rows.flatMap((row) => {
      const fields = addedFields(options.neutralize, row);
      return fields === null ? [] : [{ id: Number(row.id), added: fields }];
    });
    if (added.length > 0) {
      await tx.execute(sql`
        UPDATE events AS e SET payload = e.payload || v.added
        FROM jsonb_to_recordset(${JSON.stringify(added)}::jsonb) AS v(id bigint, added jsonb)
        WHERE e.id = v.id`);
    }
    const hi = Number(rows[rows.length - 1]?.id);
    const safe = rows.filter((row) => row.safe).at(-1);
    const next = Math.max(cursor, safe === undefined ? cursor : Number(safe.id));
    if (next !== cursor) {
      await tx.execute(
        sql`UPDATE neutral_field_progress SET filled_through = ${next}, updated_at = now() WHERE id = 1`,
      );
    }
    return { n: rows.length, filled: added.length, hi, cursor: next };
  });
}

// The stored payload goes to the codec as it is: parsing it would drop the
// keys the contract does not name, and only keys it lacks are written back.
function addedFields(
  neutralize: NeutralizeEvent,
  row: BatchRow,
): Record<string, unknown> | null {
  const data = row.payload;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const stored = data as Record<string, unknown>;
  const out = neutralize(row.profile_id, {
    event: row.type,
    data: stored,
  } as SessionEventPayload).data as Record<string, unknown>;
  const added = Object.entries(out).filter(([key]) => !(key in stored));
  return added.length === 0 ? null : Object.fromEntries(added);
}

import {
  SESSION_ACTIVITY_TEXT_MAX,
  SESSION_ACTIVITY_WINDOW_EVENTS,
  type SessionActivity,
} from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";
import { events } from "./schema.ts";

/*
 * The list card's activity line and counts for a page of sessions, in one
 * statement: each session's newest events by the (session_id, id) index, so
 * the cost follows the page size and the window, not a session's history.
 * Calls, results and their states follow the agent map's run tree
 * (packages/react run-tree.ts). The window is a suffix of the stream, so a
 * call inside it has its result, question and turn end inside it too.
 *
 * Calls pair with results by grouping one stream, never by joining: the
 * planner cannot estimate rows filtered on jsonb fields and chose nested
 * loops of window × window per page.
 */

const TARGET_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
] as const;
// A call may not take the run tree's root id.
const ROOT_RUN_ID = "root";
// Past these the session is not working, whatever calls are still open.
const LIVE_PHASES = ["running", "needs_input", "interrupting"];
// left() counts code points.
const TEXT_MAX = SESSION_ACTIVITY_TEXT_MAX;

const str = (value: SQL) =>
  sql`CASE WHEN jsonb_typeof(${value}) = 'string' THEN ${value} #>> '{}' END`;

const target = (input: SQL) =>
  sql`coalesce(${sql.join(
    TARGET_KEYS.map((key) => sql`nullif(${str(sql`${input} -> ${key}`)}, '')`),
    sql`, `,
  )}, '')`;

const epochMs = (value: SQL) =>
  sql`(extract(epoch FROM ${value}) * 1000)::float8`;

// The first of a call's rows in stream order.
const firstUse = (value: SQL) =>
  sql`(array_agg(${value} ORDER BY at, id, ord) FILTER (WHERE kind = 'use'))[1]`;

export function activityQuery(ids: readonly string[]) {
  const window = SESSION_ACTIVITY_WINDOW_EVENTS;
  const live = sql.join(
    LIVE_PHASES.map((phase) => sql`${phase}`),
    sql`, `,
  );
  return sql`
    WITH page AS (
      SELECT unnest(ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]) AS session_id
    ),
    stream AS (
      SELECT p.session_id, e.id, e.type, e.turn_id, e.at, e.created_at,
             b.ord,
             CASE WHEN b.ord IS NULL THEN e.type ELSE b.kind END AS kind,
             coalesce(b.tool_id, e.ref_tool) AS tool_id,
             b.spawns, e.parent, e.error, e.phase
      FROM page p
      CROSS JOIN LATERAL (
        SELECT id, type, turn_id, created_at,
               coalesce(occurred_at, created_at) AS at,
               CASE WHEN type IN ('tool_result', 'question')
                    THEN ${str(sql`payload -> 'tool_use_id'`)} END AS ref_tool,
               CASE WHEN type = 'tool_result'
                    THEN payload -> 'is_error' = 'true'::jsonb END AS error,
               CASE WHEN type = 'status' THEN payload ->> 'phase' END AS phase,
               CASE WHEN type IN ('assistant', 'tool_use')
                    THEN ${str(sql`payload -> 'parent_tool_use_id'`)} END AS parent,
               CASE WHEN type IN ('assistant', 'tool_use')
                     AND jsonb_typeof(payload -> 'message' -> 'content') = 'array'
                    THEN payload -> 'message' -> 'content' END AS content
        FROM ${events}
        WHERE session_id = p.session_id
        ORDER BY id DESC
        LIMIT ${window}
      ) e
      -- Rows stay narrow for the sorts below; the two blocks shown are read
      -- again by id at the end.
      LEFT JOIN LATERAL (
        SELECT ord,
               CASE WHEN block ->> 'type' = 'text' THEN 'text' ELSE 'use' END AS kind,
               CASE WHEN block ->> 'type' = 'tool_use' THEN block ->> 'id' END AS tool_id,
               block -> 'name' IN ('"Task"'::jsonb, '"Agent"'::jsonb) AS spawns
        FROM jsonb_array_elements(e.content) WITH ORDINALITY AS c(block, ord)
        WHERE (block ->> 'type' = 'tool_use'
               AND jsonb_typeof(block -> 'id') = 'string'
               AND block ->> 'id' NOT IN ('', ${ROOT_RUN_ID}))
           OR (block ->> 'type' = 'text'
               AND jsonb_typeof(block -> 'text') = 'string'
               AND block ->> 'text' ~ '\\S')
      ) b ON true
    ),
    flagged AS (
      SELECT *,
             -- A question is answered once the session moves on from needs_input.
             coalesce(bool_or(type = 'status' AND phase IS DISTINCT FROM 'needs_input') OVER later, false) AS answered_after,
             coalesce(bool_or(type = 'status' AND phase NOT IN (${live})) OVER later, false) AS stopped_after,
             turn_id IS NOT NULL AND bool_or(type = 'result') OVER (PARTITION BY session_id, turn_id) AS turn_ended
      FROM stream
      WINDOW later AS (
        PARTITION BY session_id ORDER BY at DESC, id DESC, ord DESC NULLS LAST
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      )
    ),
    calls AS (
      -- A call recorded twice keeps its earliest frame; a later question
      -- replaces an earlier one for the same call.
      SELECT session_id, tool_id,
             bool_or(spawns) FILTER (WHERE kind = 'use') AS spawns,
             ${firstUse(sql`at`)} AS used_at,
             ${firstUse(sql`id`)} AS use_id,
             ${firstUse(sql`ord`)} AS use_ord,
             ${firstUse(sql`stopped_after OR turn_ended`)} AS interrupted,
             bool_or(kind = 'tool_result') AS has_result,
             coalesce((array_agg(error ORDER BY at, id) FILTER (WHERE kind = 'tool_result'))[1], false) AS error,
             coalesce((array_agg(NOT answered_after ORDER BY at DESC, id DESC) FILTER (WHERE kind = 'question'))[1], false) AS waiting,
             (array_agg(at ORDER BY at DESC, id DESC) FILTER (WHERE kind = 'question'))[1] AS asked_at,
             (array_agg(id ORDER BY at DESC, id DESC) FILTER (WHERE kind = 'question'))[1] AS question_id
      FROM flagged
      WHERE tool_id IS NOT NULL
      GROUP BY session_id, tool_id
      HAVING bool_or(kind = 'use')
    ),
    counts AS (
      SELECT session_id,
             count(*)::int AS tool_count,
             count(*) FILTER (WHERE error)::int AS error_count
      FROM calls
      GROUP BY session_id
    ),
    -- The run tree's runs besides the session's own: one per Task or Agent
    -- call, and one per call its events name as their parent, whether or
    -- not that call is in the window.
    runs AS (
      SELECT session_id, tool_id AS run_id FROM calls WHERE spawns
      UNION
      SELECT session_id, parent FROM stream
      WHERE parent IS NOT NULL AND parent NOT IN ('', ${ROOT_RUN_ID})
    ),
    run_counts AS (
      SELECT session_id, count(*)::int AS subagent_count FROM runs GROUP BY session_id
    ),
    current AS (
      SELECT DISTINCT ON (session_id) session_id, tool_id, use_id, use_ord, waiting, question_id,
             CASE WHEN waiting THEN asked_at ELSE used_at END AS since
      FROM calls
      WHERE NOT has_result AND NOT interrupted
      ORDER BY session_id, used_at DESC, use_id DESC, use_ord DESC
    ),
    last AS (
      SELECT DISTINCT ON (session_id) session_id, kind, id, ord
      FROM stream
      WHERE kind IN ('use', 'text')
      ORDER BY session_id, at DESC, id DESC, ord DESC
    ),
    span AS (
      SELECT session_id, count(DISTINCT id)::int AS events,
             ${epochMs(sql`min(created_at)`)} AS since_ms
      FROM stream
      GROUP BY session_id
    )
    SELECT p.session_id::text AS session_id,
           coalesce(sp.events, 0) AS events,
           NOT EXISTS (
             SELECT 1 FROM ${events}
             WHERE session_id = p.session_id
             ORDER BY id DESC OFFSET ${window} LIMIT 1
           ) AS complete,
           sp.since_ms,
           coalesce(c.tool_count, 0) AS tool_count,
           coalesce(c.error_count, 0) AS error_count,
           coalesce(rc.subagent_count, 0) AS subagent_count,
           l.kind AS last_kind,
           CASE WHEN l.kind = 'text' THEN
             left(btrim((SELECT line FROM regexp_split_to_table(lb.block ->> 'text', E'\\r?\\n') AS line
                         WHERE line ~ '\\S' LIMIT 1), E' \\t'), ${TEXT_MAX})
           END AS last_text,
           coalesce(${str(sql`lb.block -> 'name'`)}, '') AS last_name,
           ${target(sql`lb.block -> 'input'`)} AS last_target,
           cur.tool_id AS current_id,
           coalesce(${str(sql`cb.block -> 'name'`)}, '') AS current_name,
           ${target(sql`cb.block -> 'input'`)} AS current_target,
           cur.waiting AS current_waiting,
           ${epochMs(sql`cur.since`)} AS current_since_ms,
           qb.payload ->> 'kind' AS request_kind,
           CASE WHEN qb.payload ->> 'kind' = 'question' THEN
             -- The control plane stores each question as a pending question
             -- (prompt); an older worker published the SDK's input (question).
             left(regexp_replace((SELECT x.t
                         FROM jsonb_array_elements(
                           CASE WHEN jsonb_typeof(qb.payload -> 'input' -> 'questions') = 'array'
                                THEN qb.payload -> 'input' -> 'questions' ELSE '[]'::jsonb END
                         ) AS q
                         CROSS JOIN LATERAL (
                           SELECT coalesce(${str(sql`q -> 'prompt'`)}, ${str(sql`q -> 'question'`)}) AS t
                         ) x
                         WHERE x.t ~ '\\S'
                         LIMIT 1), '^\\s+|\\s+$', '', 'g'), ${TEXT_MAX})
           END AS request_prompt
    FROM page p
    LEFT JOIN span sp USING (session_id)
    LEFT JOIN counts c USING (session_id)
    LEFT JOIN run_counts rc USING (session_id)
    LEFT JOIN last l USING (session_id)
    LEFT JOIN current cur USING (session_id)
    LEFT JOIN LATERAL (
      SELECT payload -> 'message' -> 'content' -> (l.ord::int - 1) AS block
      FROM ${events} WHERE id = l.id
    ) lb ON true
    LEFT JOIN LATERAL (
      SELECT payload -> 'message' -> 'content' -> (cur.use_ord::int - 1) AS block
      FROM ${events} WHERE id = cur.use_id
    ) cb ON true
    LEFT JOIN LATERAL (
      SELECT payload FROM ${events} WHERE id = cur.question_id AND cur.waiting
    ) qb ON true
  `;
}

interface ActivityRow {
  session_id: string;
  events: number;
  complete: boolean;
  since_ms: number | null;
  tool_count: number;
  error_count: number;
  subagent_count: number;
  last_kind: string | null;
  last_text: string | null;
  last_name: string | null;
  last_target: string | null;
  current_id: string | null;
  current_name: string | null;
  current_target: string | null;
  current_waiting: boolean | null;
  current_since_ms: number | null;
  request_kind: string | null;
  request_prompt: string | null;
}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(Number(ms)).toISOString();

function activityOf(row: ActivityRow): SessionActivity {
  return {
    last:
      row.last_kind === "text" && row.last_text
        ? { kind: "text", text: row.last_text }
        : row.last_kind === "use"
          ? {
              kind: "tool",
              name: row.last_name ?? "",
              target: row.last_target ?? "",
            }
          : null,
    tool_count: row.tool_count,
    error_count: row.error_count,
    subagent_count: row.subagent_count,
    current_tool:
      row.current_id === null
        ? null
        : {
            id: row.current_id,
            name: row.current_name ?? "",
            target: row.current_target ?? "",
            state: row.current_waiting ? "waiting" : "running",
            since: iso(row.current_since_ms) as string,
            request:
              row.request_kind === null
                ? null
                : {
                    kind:
                      row.request_kind === "permission"
                        ? "permission"
                        : "question",
                    prompt: row.request_prompt || null,
                  },
          },
    window: {
      events: row.events,
      complete: row.complete,
      since: iso(row.since_ms),
    },
  };
}

export async function readSessionActivity(
  executor: Database,
  ids: readonly string[],
): Promise<Map<string, SessionActivity>> {
  if (ids.length === 0) return new Map();
  const rows = await executor.transaction(async (tx) => {
    // The plan's cost counts every event a listed session has, not the
    // window, and crosses jit_above_cost: compiling took longer than the
    // statement then ran (86 of 297 ms for 100 sessions in the bench).
    await tx.execute(sql`SET LOCAL jit = off`);
    return rowsOf<ActivityRow>(await tx.execute(activityQuery(ids)));
  });
  return new Map(rows.map((row) => [row.session_id, activityOf(row)]));
}

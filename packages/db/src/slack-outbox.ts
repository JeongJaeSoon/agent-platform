import { randomUUID } from "node:crypto";
import type {
  SlackOutboxFence,
  SlackOutboxStore,
  SlackUnansweredTurn,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { actionableOfTurn } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import {
  agents,
  events,
  linkedAccounts,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  surfaceBindings,
  turns,
} from "./schema.ts";

const t = slackOutbox;

const entry = {
  workspaceId: t.workspaceId,
  agentId: t.agentId,
  slackAppId: t.slackAppId,
  installationId: t.installationId,
  kind: t.kind,
  channelId: t.channelId,
  threadTs: t.threadTs,
  slackUserId: t.slackUserId,
  sessionId: t.sessionId,
  body: t.body,
  dedupeKey: t.dedupeKey,
};

const released = { claimToken: null, leaseExpiresAt: null } as const;

// The fence alone, with no lease test: a claimed row whose lease ran out is
// either reclaimed (a new token) or, mid-send, moved to `uncertain` (no
// token), and both fail this.
const fenced = (fence: SlackOutboxFence) =>
  and(eq(t.id, fence.id), eq(t.claimToken, fence.claimToken));

// Where a row may still go: an installation not revoked, for a session's row
// its thread's link still live, unmuted and showing full answers, and for an
// input notice a request still waiting (its key ends in the turn). Checked
// again at claim, since a row can wait out a backoff after any of it changed.
const addressed = (db: Database, row: SQL) => sql`(
  CASE WHEN ${row}.kind = 'input_notice' THEN EXISTS (
    SELECT 1 FROM ${turns}
    WHERE ${turns.sessionId} = ${row}.session_id
      AND ${turns.sequence} = split_part(${row}.dedupe_key, ':', 3)::int
      AND EXISTS (${actionableOfTurn(db)})
  ) ELSE true END
  AND EXISTS (
    SELECT 1 FROM slack_installations i
    WHERE i.id = ${row}.installation_id AND i.status <> 'revoked'
  )
  AND (${row}.session_id IS NULL OR EXISTS (
    SELECT 1 FROM session_links l
    WHERE l.session_id = ${row}.session_id
      AND l.installation_id = ${row}.installation_id
      AND l.channel_id = ${row}.channel_id
      AND l.thread_id = ${row}.thread_ts
      AND l.revoked_at IS NULL
      AND NOT l.muted
      AND l.visibility = 'full'
  ))
)`;

export function createPostgresSlackOutboxStore(db: Database): SlackOutboxStore {
  return {
    async enqueue(input, whileHome) {
      return db.transaction(async (tx) => {
        if (whileHome) {
          const [home] = await tx
            .select({ id: surfaceBindings.id })
            .from(surfaceBindings)
            .where(
              and(
                eq(surfaceBindings.id, whileHome.bindingId),
                eq(surfaceBindings.agentId, input.agentId),
                eq(surfaceBindings.home, true),
                ne(surfaceBindings.mode, "off"),
                isNull(surfaceBindings.revokedAt),
              ),
            )
            .for("share");
          const [live] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, input.agentId),
                eq(agents.activeReleaseId, whileHome.releaseId),
              ),
            )
            .for("share");
          if (!home || !live) return "not_home";
        }
        const [row] = await tx
          .insert(t)
          .values({ ...input, id: randomUUID() })
          .onConflictDoNothing({ target: t.dedupeKey })
          .returning({ id: t.id });
        return row ? "enqueued" : "duplicate";
      });
    },

    async advanceAnswered() {
      // Writes only links whose mark moves, so a quiet pass writes nothing.
      const { rows } = (await db.execute(sql`
        UPDATE session_links l SET answered_through = m.mark
        FROM (
          SELECT l2.id, coalesce(
            (SELECT min(t.sequence) - 1 FROM ${turns} t
             WHERE t.session_id = l2.session_id
               AND t.sequence > l2.answered_through
               AND NOT (
                 t.status IN ('interrupted', 'cancelled')
                 OR (t.status IN ('completed', 'failed', 'outcome_unknown')
                   AND t.created_at < l2.created_at)
                 -- Not outcome_unknown: an operator may yet confirm it
                 -- completed, and then it owes its reply.
                 OR (t.status IN ('completed', 'failed') AND EXISTS (
                   SELECT 1 FROM ${t} o
                   WHERE o.dedupe_key = (CASE WHEN t.status = 'completed' THEN 'reply' ELSE 'failure' END)
                     || ':' || l2.id || ':' || t.sequence
                 ))
               )),
            (SELECT max(t.sequence) FROM ${turns} t WHERE t.session_id = l2.session_id),
            0
          ) AS mark
          FROM session_links l2
          WHERE l2.session_id IS NOT NULL
            AND l2.revoked_at IS NULL
            AND NOT l2.muted
            AND l2.visibility = 'full'
        ) m
        WHERE l.id = m.id AND m.mark > l.answered_through
        RETURNING l.id
      `)) as unknown as { rows: unknown[] };
      return rows.length;
    },

    async unansweredTurns(limit) {
      // The keys platform's slackTurnDedupeKey makes, spelled in SQL.
      const prefix = sql`CASE WHEN ${turns.status} = 'completed' THEN 'reply' WHEN ${turns.status} IN ('failed', 'outcome_unknown') THEN 'failure' ELSE 'input' END`;
      const rows = await db
        .select({
          sessionLinkId: sessionLinks.id,
          sessionId: sessions.id,
          workspaceId: sessionLinks.workspaceId,
          agentId: sessionLinks.agentId,
          slackAppId: slackApps.id,
          installationId: sessionLinks.installationId,
          channelId: sessionLinks.channelId,
          threadTs: sessionLinks.threadId,
          turnRowId: turns.id,
          turnId: turns.sequence,
          status: turns.status,
          attemptId: turns.attemptId,
          requesterSlackUserId: linkedAccounts.externalUserId,
        })
        .from(sessionLinks)
        .innerJoin(sessions, eq(sessions.id, sessionLinks.sessionId))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, sessionLinks.installationId),
        )
        .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
        .innerJoin(turns, eq(turns.sessionId, sessionLinks.sessionId))
        .leftJoin(
          linkedAccounts,
          and(
            eq(linkedAccounts.workspaceId, sessionLinks.workspaceId),
            eq(
              linkedAccounts.userId,
              sql`coalesce(${turns.actorId}, ${sessionLinks.createdBy})`,
            ),
            eq(linkedAccounts.provider, "slack"),
            eq(linkedAccounts.externalTenant, slackInstallations.teamId),
            eq(linkedAccounts.status, "active"),
          ),
        )
        .where(
          and(
            // The turns past each live link's mark, found first by a range
            // per link; joined on its own, the planner sorts every turn. The
            // LIMIT keeps the range per link (unlimited, it is flattened
            // into a scan of all turns), and a pass takes no more anyway.
            // Turns with nothing left to send are skipped before it, so the
            // ones behind a turn holding the mark are still reached.
            sql`${turns.id} = ANY (ARRAY(
              SELECT open.id FROM session_links ol
              CROSS JOIN LATERAL (
                SELECT ot.id FROM ${turns} ot
                WHERE ot.session_id = ol.session_id
                  AND ot.sequence > ol.answered_through
                  AND ot.status NOT IN ('queued', 'interrupted', 'cancelled')
                  AND NOT (ot.status IN ('completed', 'failed', 'outcome_unknown')
                    AND ot.created_at < ol.created_at)
                  AND NOT EXISTS (
                    SELECT 1 FROM ${t} oo
                    WHERE oo.dedupe_key = (CASE WHEN ot.status = 'completed' THEN 'reply'
                        WHEN ot.status IN ('failed', 'outcome_unknown') THEN 'failure'
                        ELSE 'input' END)
                      || ':' || ol.id || ':' || ot.sequence
                  )
                ORDER BY ot.sequence
                LIMIT ${limit}
              ) open
              WHERE ol.revoked_at IS NULL
                AND NOT ol.muted
                AND ol.visibility = 'full'
            ))`,
            isNull(sessionLinks.revokedAt),
            // A muted or summary-only thread is not where a full answer goes.
            eq(sessionLinks.muted, false),
            eq(sessionLinks.visibility, "full"),
            ne(slackInstallations.status, "revoked"),
            or(
              and(
                inArray(turns.status, [
                  "completed",
                  "failed",
                  "outcome_unknown",
                ]),
                // A turn from before the thread is not the thread's to answer.
                gte(turns.createdAt, sessionLinks.createdAt),
              ),
              sql`EXISTS (${actionableOfTurn(db)})`,
            ),
            sql`NOT EXISTS (
              SELECT 1 FROM ${t} o
              WHERE o.dedupe_key = ${prefix} || ':' || ${sessionLinks.id} || ':' || ${turns.sequence}
            )`,
          ),
        )
        // Not by turns.id, which walks every turn in the table; within a
        // thread, its own order.
        .orderBy(
          asc(turns.createdAt),
          asc(turns.sessionId),
          asc(turns.sequence),
        )
        .limit(limit);
      const completed = rows.filter(
        (row) => row.status === "completed" && row.attemptId !== null,
      );
      const said =
        completed.length === 0
          ? []
          : await db
              .select({
                turnId: events.turnId,
                type: events.type,
                payload: events.payload,
              })
              .from(events)
              .innerJoin(
                turns,
                and(
                  eq(turns.id, events.turnId),
                  eq(turns.attemptId, events.attemptId),
                ),
              )
              .where(
                and(
                  inArray(
                    events.turnId,
                    completed.map((row) => row.turnRowId),
                  ),
                  inArray(events.type, ["assistant", "tool_use"]),
                  // Subagent output is the subagent's, not the turn's answer.
                  sql`${events.payload}->>'parent_tool_use_id' IS NULL`,
                ),
              )
              .orderBy(asc(events.turnId), asc(events.sourceSequence));
      return rows.map(
        ({ turnRowId, status, attemptId: _, ...row }): SlackUnansweredTurn => ({
          ...row,
          state:
            status === "completed"
              ? "completed"
              : status === "failed" || status === "outcome_unknown"
                ? "failed"
                : "needs_input",
          events: said
            .filter((event) => event.turnId === turnRowId)
            .map(({ type, payload }) => ({ type, payload })),
        }),
      );
    },

    async expireSending() {
      return db
        .update(t)
        .set({ status: "uncertain", errorCode: "lease_expired", ...released })
        .where(and(eq(t.status, "sending"), sql`${t.leaseExpiresAt} <= now()`))
        .returning({ id: t.id, ...entry });
    },

    async closeUnaddressed() {
      return db
        .update(t)
        .set({ status: "failed", errorCode: "not_addressed", ...released })
        .where(
          and(
            eq(t.status, "pending"),
            sql`NOT ${addressed(db, sql.raw('"slack_outbox"'))}`,
          ),
        )
        .returning({ id: t.id, kind: t.kind, channelId: t.channelId });
    },

    async untoldUncertain(limit) {
      // The key platform's drain gives the notice, spelled in SQL.
      return db
        .select({ id: t.id, ...entry })
        .from(t)
        .where(
          and(
            eq(t.kind, "reply"),
            eq(t.status, "uncertain"),
            sql`${t.sessionId} IS NOT NULL`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${t} n WHERE n.dedupe_key = 'uncertain:' || ${t.id}
            )`,
          ),
        )
        .orderBy(asc(t.seq))
        .limit(limit);
    },

    async claim({ limit, leaseMs }) {
      const rows = await db
        .update(t)
        .set({
          claimToken: sql`gen_random_uuid()`,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        })
        .where(
          sql`${t.id} IN (
            SELECT c.id FROM slack_outbox c
            WHERE c.status = 'pending'
              AND (c.claim_token IS NULL OR c.lease_expires_at <= now())
              AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
              AND ${addressed(db, sql.raw("c"))}
            ORDER BY c.seq
            LIMIT ${limit}
            FOR UPDATE OF c SKIP LOCKED
          )`,
        )
        .returning({
          id: t.id,
          claimToken: t.claimToken,
          attempts: t.attempts,
          seq: t.seq,
          ...entry,
        });
      return rows
        .sort((a, b) => a.seq - b.seq)
        .map(({ seq: _, claimToken, attempts, ...row }) => ({
          ...row,
          // Counted once this attempt is decided: beginSend, or a settle
          // that never began, so a claim whose lease lapses unsent is free.
          attempts: attempts + 1,
          // Set by this very update.
          claimToken: claimToken as string,
        }));
    },

    async beginSend(fence) {
      const rows = await db
        .update(t)
        .set({ status: "sending", attempts: sql`${t.attempts} + 1` })
        .where(
          and(
            fenced(fence),
            eq(t.status, "pending"),
            sql`${t.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: t.id });
      return rows.length > 0;
    },

    async settle(fence, outcome) {
      const set =
        outcome.status === "sent"
          ? {
              status: "sent" as const,
              slackTs: outcome.slackTs,
              errorCode: null,
            }
          : outcome.status === "pending"
            ? {
                status: "pending" as const,
                errorCode: outcome.errorCode,
                nextAttemptAt: sql`now() + make_interval(secs => ${outcome.retryInMs / 1000})`,
              }
            : { status: outcome.status, errorCode: outcome.errorCode };
      const rows = await db
        .update(t)
        .set({
          ...set,
          ...released,
          // SET reads the old status: still pending means beginSend never ran.
          attempts: sql`CASE WHEN ${t.status} = 'pending' THEN ${t.attempts} + 1 ELSE ${t.attempts} END`,
        })
        .where(fenced(fence))
        .returning({ id: t.id });
      return rows.length > 0;
    },
  };
}

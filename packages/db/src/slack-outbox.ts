import { randomUUID } from "node:crypto";
import type {
  SlackOutboxFence,
  SlackOutboxStore,
  SlackUnansweredTurn,
} from "@werft-ai/platform";
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { actionableOfTurn } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import {
  events,
  linkedAccounts,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
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

export function createPostgresSlackOutboxStore(db: Database): SlackOutboxStore {
  return {
    async enqueue(input) {
      const [row] = await db
        .insert(t)
        .values({ ...input, id: randomUUID() })
        .onConflictDoNothing({ target: t.dedupeKey })
        .returning({ id: t.id });
      return row ? "enqueued" : "duplicate";
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
        .innerJoin(turns, eq(turns.sessionId, sessions.id))
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
        .orderBy(asc(turns.id))
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

    async claim({ limit, leaseMs }) {
      const rows = await db
        .update(t)
        .set({
          claimToken: sql`gen_random_uuid()`,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
          attempts: sql`${t.attempts} + 1`,
        })
        .where(
          sql`${t.id} IN (
            SELECT c.id FROM slack_outbox c
            WHERE c.status = 'pending'
              AND (c.claim_token IS NULL OR c.lease_expires_at <= now())
              AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
            ORDER BY c.created_at, c.id
            LIMIT ${limit}
            FOR UPDATE OF c SKIP LOCKED
          )`,
        )
        .returning({
          id: t.id,
          claimToken: t.claimToken,
          attempts: t.attempts,
          createdAt: t.createdAt,
          ...entry,
        });
      return rows
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .map(({ createdAt: _, claimToken, ...row }) => ({
          ...row,
          // Set by this very update.
          claimToken: claimToken as string,
        }));
    },

    async beginSend(fence) {
      const rows = await db
        .update(t)
        .set({ status: "sending" })
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
        .set({ ...set, ...released })
        .where(fenced(fence))
        .returning({ id: t.id });
      return rows.length > 0;
    },
  };
}

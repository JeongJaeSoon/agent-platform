import { randomUUID } from "node:crypto";
import {
  GITHUB_PURPOSE_VALUES,
  GITHUB_REFUSAL_VALUES,
  type GitHubPullRequestOutcomeMetadata,
  type GitHubPullRequestOutcomeState,
  type GitHubPurpose,
  type GitHubRefusal,
  type SessionGitHubRefusal,
  type SessionOutcome,
  type SessionOutcomeCheckError,
} from "@werft-ai/contracts";
import type { ClaimedOutcome, SessionOutcomeStore } from "@werft-ai/platform";
import { and, asc, eq, sql } from "drizzle-orm";
import { insertPullRequestOutcome } from "./pull-requests.ts";
import type { Database } from "./queries.ts";
import { outcomeRefreshQuotas, sessionOutcomes } from "./schema.ts";

// A unit's hourly budget is this share of its rate limit (§10).
const BUDGET_SHARE = 0.2;
const BUDGET_UNKNOWN = 1000;

// Due for a read (§10's interval table): never answered, or answered longer
// ago than the state's interval. A merged one, and one closed over 30 days
// ago, are not read again.
const due = sql`${sessionOutcomes.type} = 'github_pull_request'
  AND ${sessionOutcomes.state} <> 'merged'
  AND (${sessionOutcomes.leaseExpiresAt} IS NULL OR ${sessionOutcomes.leaseExpiresAt} < now())
  AND (
    (${sessionOutcomes.state} = 'open' AND (
      ${sessionOutcomes.stateCheckedAt} IS NULL
      OR ${sessionOutcomes.stateCheckedAt} < now() - CASE
        WHEN ${sessionOutcomes.createdAt} > now() - interval '1 day' THEN interval '5 minutes'
        WHEN ${sessionOutcomes.createdAt} > now() - interval '30 days' THEN interval '1 hour'
        ELSE interval '1 day' END))
    OR (${sessionOutcomes.state} = 'closed'
      AND (${sessionOutcomes.closedAt} IS NULL OR ${sessionOutcomes.closedAt} > now() - interval '30 days')
      AND (${sessionOutcomes.stateCheckedAt} IS NULL
        OR ${sessionOutcomes.stateCheckedAt} < now() - interval '1 day'))
  )`;

type Row = typeof sessionOutcomes.$inferSelect;

function metadataOf(row: Row): GitHubPullRequestOutcomeMetadata {
  const value = row.metadata as Partial<GitHubPullRequestOutcomeMetadata>;
  const count = (field: unknown) =>
    typeof field === "number" && Number.isInteger(field) && field >= 0
      ? field
      : null;
  return {
    head: typeof value.head === "string" ? value.head : "",
    base: typeof value.base === "string" ? value.base : "",
    adopted: typeof value.adopted === "boolean" ? value.adopted : null,
    merge_commit_sha:
      typeof value.merge_commit_sha === "string"
        ? value.merge_commit_sha
        : null,
    additions: count(value.additions),
    deletions: count(value.deletions),
    changed_files: count(value.changed_files),
    commits: count(value.commits),
  };
}

function publicOutcome(row: Row): SessionOutcome {
  return {
    id: row.id,
    type: row.type,
    url: row.url,
    repository_id: row.repositoryId,
    external_id: row.externalId,
    state: row.state,
    state_changed_at: row.stateChangedAt.toISOString(),
    merged_at: row.mergedAt?.toISOString() ?? null,
    closed_at: row.closedAt?.toISOString() ?? null,
    state_checked_at: row.stateCheckedAt?.toISOString() ?? null,
    check_error: row.checkError,
    metadata: metadataOf(row),
    created_at: row.createdAt.toISOString(),
  };
}

const GATE_OPERATIONS = [
  "mint_github_token",
  "dispatch_workflow",
  "rerun_workflow",
  "review_pull_request",
] as const;

export function createPostgresSessionOutcomes(
  db: Database,
): SessionOutcomeStore {
  return {
    async fillMissing(limit) {
      // pull_requests rows a push request opened with no outcome yet.
      const { rows } = (await db.execute(sql`
        SELECT pr.owner_id, pr.session_id, pr.url, pr.repository_id, pr.number,
               pr.head, pr.base, pr.receipt_id, pr.created_at
        FROM pull_requests pr
        WHERE pr.push_request_id IS NOT NULL
          AND pr.owner_id IS NOT NULL AND pr.repository_id IS NOT NULL
          AND pr.number IS NOT NULL AND pr.head IS NOT NULL
          AND pr.base IS NOT NULL AND pr.receipt_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM session_outcomes o
            WHERE o.session_id = pr.session_id
              AND o.type = 'github_pull_request' AND o.url = pr.url)
        ORDER BY pr.created_at
        LIMIT ${limit}`)) as unknown as {
        rows: {
          owner_id: string;
          session_id: string;
          url: string;
          repository_id: string;
          number: number;
          head: string;
          base: string;
          receipt_id: string;
          created_at: Date | string | null;
        }[];
      };
      for (const row of rows) {
        await insertPullRequestOutcome(db, {
          ownerId: row.owner_id,
          sessionId: row.session_id,
          url: row.url,
          repositoryId: row.repository_id,
          number: row.number,
          head: row.head,
          base: row.base,
          adopted: null,
          receiptId: row.receipt_id,
          createdAt:
            row.created_at === null ? new Date() : new Date(row.created_at),
        });
      }
      return rows.length;
    },

    async dueRepositories() {
      const rows = await db
        .selectDistinct({ repositoryId: sessionOutcomes.repositoryId })
        .from(sessionOutcomes)
        .where(and(due, sql`${sessionOutcomes.repositoryId} IS NOT NULL`));
      return rows.flatMap((row) =>
        row.repositoryId === null ? [] : [row.repositoryId],
      );
    },

    claim(input) {
      if (input.repositoryIds.length === 0 || input.max <= 0) {
        return Promise.resolve([]);
      }
      return db.transaction(async (tx) => {
        await tx
          .insert(outcomeRefreshQuotas)
          .values({ quotaKey: input.quotaKey })
          .onConflictDoNothing();
        // The row lock makes the check and the spend one step for every
        // replica: two claims of one unit never pass the budget together.
        const [quota] = await tx
          .select({
            rateLimit: outcomeRefreshQuotas.rateLimit,
            used: sql<number>`CASE WHEN ${outcomeRefreshQuotas.windowStart} < now() - interval '1 hour' THEN 0 ELSE ${outcomeRefreshQuotas.used} END`.mapWith(
              Number,
            ),
            paused: sql<boolean>`coalesce(${outcomeRefreshQuotas.pausedUntil} > now(), false)`,
            stale: sql<boolean>`${outcomeRefreshQuotas.windowStart} < now() - interval '1 hour'`,
          })
          .from(outcomeRefreshQuotas)
          .where(eq(outcomeRefreshQuotas.quotaKey, input.quotaKey))
          .for("update");
        if (!quota) throw new Error("outcome quota row missing");
        if (quota.stale) {
          await tx
            .update(outcomeRefreshQuotas)
            .set({ windowStart: sql`now()`, used: 0 })
            .where(eq(outcomeRefreshQuotas.quotaKey, input.quotaKey));
        }
        if (quota.paused) return [];
        const budget =
          quota.rateLimit === null
            ? BUDGET_UNKNOWN
            : Math.floor(quota.rateLimit * BUDGET_SHARE);
        const take = Math.min(input.max, budget - quota.used);
        if (take <= 0) return [];
        const leaseToken = randomUUID();
        const repositories = sql.join(
          input.repositoryIds.map((id) => sql`${id}`),
          sql`, `,
        );
        const claimed = await tx
          .update(sessionOutcomes)
          .set({
            leaseToken,
            leaseExpiresAt: sql`now() + make_interval(secs => ${input.leaseMs / 1000})`,
          })
          .where(
            sql`${sessionOutcomes.id} IN (SELECT ${sessionOutcomes.id} FROM ${sessionOutcomes} WHERE ${due} AND ${sessionOutcomes.repositoryId} IN (${repositories}) AND ${sessionOutcomes.externalId} IS NOT NULL ORDER BY ${sessionOutcomes.stateCheckedAt} NULLS FIRST, ${sessionOutcomes.createdAt} LIMIT ${take} FOR UPDATE SKIP LOCKED)`,
          )
          .returning();
        if (claimed.length > 0) {
          await tx
            .update(outcomeRefreshQuotas)
            .set({
              used: sql`${outcomeRefreshQuotas.used} + ${claimed.length}`,
            })
            .where(eq(outcomeRefreshQuotas.quotaKey, input.quotaKey));
        }
        return claimed.flatMap((row): ClaimedOutcome[] => {
          const number = Number(row.externalId);
          if (row.repositoryId === null || !Number.isSafeInteger(number)) {
            return [];
          }
          return [
            {
              id: row.id,
              sessionId: row.sessionId,
              repositoryId: row.repositoryId,
              number,
              state: row.state,
              leaseToken,
            },
          ];
        });
      });
    },

    async finish(outcome, check) {
      const held = and(
        eq(sessionOutcomes.id, outcome.id),
        eq(sessionOutcomes.leaseToken, outcome.leaseToken),
      );
      const released = { leaseToken: null, leaseExpiresAt: null };
      if (check.kind === "release") {
        const rows = await db
          .update(sessionOutcomes)
          .set(released)
          .where(held)
          .returning({ id: sessionOutcomes.id });
        return rows.length > 0;
      }
      if (check.kind === "error") {
        const rows = await db
          .update(sessionOutcomes)
          .set({
            ...released,
            checkError: check.checkError as SessionOutcomeCheckError,
            stateCheckedAt: sql`now()`,
          })
          .where(held)
          .returning({ id: sessionOutcomes.id });
        return rows.length > 0;
      }
      const state: GitHubPullRequestOutcomeState = check.state;
      const rows = await db
        .update(sessionOutcomes)
        .set({
          ...released,
          state,
          stateChangedAt: sql`CASE WHEN ${sessionOutcomes.state} = ${state} THEN ${sessionOutcomes.stateChangedAt} ELSE now() END`,
          mergedAt: check.mergedAt,
          closedAt: check.closedAt,
          checkError: null,
          stateCheckedAt: sql`now()`,
          metadata: sql`${sessionOutcomes.metadata} || ${JSON.stringify(check.metadata)}::jsonb`,
        })
        .where(held)
        .returning({ id: sessionOutcomes.id });
      return rows.length > 0;
    },

    async noteRateLimit(quotaKey, input) {
      await db
        .insert(outcomeRefreshQuotas)
        .values({
          quotaKey,
          rateLimit: input.limit,
          pausedUntil: input.pausedUntil,
        })
        .onConflictDoUpdate({
          target: outcomeRefreshQuotas.quotaKey,
          set: {
            rateLimit: sql`coalesce(${input.limit}::integer, ${outcomeRefreshQuotas.rateLimit})`,
            pausedUntil:
              input.pausedUntil === null
                ? sql`${outcomeRefreshQuotas.pausedUntil}`
                : sql`greatest(${outcomeRefreshQuotas.pausedUntil}, ${input.pausedUntil.toISOString()}::timestamptz)`,
          },
        });
    },

    async list(ownerId, sessionId) {
      const rows = await db
        .select()
        .from(sessionOutcomes)
        .where(
          and(
            eq(sessionOutcomes.ownerId, ownerId),
            eq(sessionOutcomes.sessionId, sessionId.toLowerCase()),
          ),
        )
        .orderBy(asc(sessionOutcomes.createdAt), asc(sessionOutcomes.id));
      return rows.map(publicOutcome);
    },

    async refusals(ownerId, sessionId, limit) {
      const operations = sql.join(
        GATE_OPERATIONS.map((operation) => sql`${operation}`),
        sql`, `,
      );
      const { rows } = (await db.execute(sql`
        SELECT id, operation, result ->> 'purpose' AS purpose,
               result ->> 'reason_code' AS reason_code, created_at
        FROM receipts
        WHERE owner_id = ${ownerId}
          AND target_ref ->> 'session_id' = ${sessionId.toLowerCase()}
          AND operation IN (${operations})
          AND status = 'failed'
          AND result ->> 'reason_code' IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`)) as unknown as {
        rows: {
          id: string;
          operation: SessionGitHubRefusal["operation"];
          purpose: string | null;
          reason_code: string;
          created_at: Date | string;
        }[];
      };
      return rows.flatMap((row): SessionGitHubRefusal[] =>
        (GITHUB_REFUSAL_VALUES as readonly string[]).includes(
          row.reason_code,
        ) &&
        (GITHUB_PURPOSE_VALUES as readonly (string | null)[]).includes(
          row.purpose,
        )
          ? [
              {
                receipt_id: row.id,
                operation: row.operation,
                purpose: row.purpose as GitHubPurpose,
                reason_code: row.reason_code as GitHubRefusal,
                created_at: new Date(row.created_at).toISOString(),
              },
            ]
          : [],
      );
    },
  };
}

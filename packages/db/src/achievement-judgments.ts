import { randomUUID } from "node:crypto";
import {
  type AchievementEvidenceKind,
  type AchievementJudgment,
  type AchievementJudgmentError,
  type AchievementJudgmentStatus,
  type AchievementJudgmentTrigger,
  type AchievementPayload,
  type AchievementReviewState,
  type AchievementRuleJudge,
  GITHUB_REVIEW_EVENT_VALUES,
  type GitHubPullRequestOutcomeState,
  type GitHubReviewEvent,
  type SessionAchievement,
  workspaceSettingsSchema,
} from "@werft-ai/contracts";
import {
  ACHIEVEMENT_JUDGMENT_QUIET_MS,
  type AchievementJudgmentStore,
  type JudgmentEgressStore,
  type OutcomeEvidence,
} from "@werft-ai/platform";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { managing } from "./achievement-rules.ts";
import { findPgError, receiptActorOf } from "./control-shared.ts";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";
import {
  achievementJudgments,
  achievementJudgmentUsage,
  achievementRules,
  achievementTypes,
  agentReleases,
  receipts,
  sessionAchievements,
  sessionOutcomes,
  sessions,
  workspaces,
} from "./schema.ts";

/** What queued a judgment, with what its workspace setting is judged on. */
export type JudgmentCause =
  | { trigger: "evidence" }
  /** The session's turn of this sequence number just ended. */
  | { trigger: "turns"; turn: number }
  | { trigger: "idle" }
  | { trigger: "manual" };

const JUDGE = sql`w.settings -> 'achievement_judge'`;

function gateOf(cause: JudgmentCause): SQL {
  switch (cause.trigger) {
    case "evidence":
      return sql`(${JUDGE} -> 'on_evidence') IS DISTINCT FROM 'false'::jsonb`;
    case "turns":
      return sql`jsonb_typeof(${JUDGE} -> 'every_n_turns') = 'number'
        AND ${cause.turn}::int % (${JUDGE} ->> 'every_n_turns')::int = 0
        AND EXISTS (
          SELECT 1 FROM achievement_rules r
          JOIN achievement_types t ON t.id = r.type_id
          WHERE r.workspace_id = w.id AND r.superseded_by IS NULL
            AND r.disabled_at IS NULL AND t.evidence_kind = 'conversation')`;
    case "idle":
      return sql`(${JUDGE} -> 'on_idle') = 'true'::jsonb`;
    case "manual":
      return sql`TRUE`;
  }
}

/**
 * Queues a judgment of the session (achievement-rules.md §4): `evidence` in
 * the transaction that wrote its evidence, `turns` and `idle` in the one
 * that ended the turn or the session's run, each when the workspace's
 * judge setting asks for it; `manual` always. A pending one already there
 * is kept and takes the newest trigger. A queued one waits the quiet time
 * again from now, never less than it already waits; a deferred one is
 * queued again after the quiet time, so its `always` pairs are counted
 * without waiting for the next day's budget and its `luna` pairs deferred
 * again. A retry it was becomes a first try, as a new trigger counts
 * afresh. Nothing is queued for a session without a workspace. Returns the
 * pending judgment's id, or null when nothing was queued.
 */
export async function queueAchievementJudgment(
  tx: Database,
  sessionId: string,
  cause: JudgmentCause = { trigger: "evidence" },
): Promise<string | null> {
  // The session row is locked before the pending index entry is taken, the
  // order a checkpoint commit's fence (FOR UPDATE) takes them in; the other
  // order deadlocks against it on the index and the foreign key.
  await tx.execute(
    sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR KEY SHARE`,
  );
  // clock_timestamp: a long transaction must not queue in its own past.
  const queued = await tx.execute(sql`
    INSERT INTO achievement_judgments
      (id, workspace_id, owner_id, session_id, trigger, status, next_attempt_at)
    SELECT ${randomUUID()}, s.workspace_id, s.owner_id, s.id, ${cause.trigger}, 'queued',
           clock_timestamp() + make_interval(secs => ${ACHIEVEMENT_JUDGMENT_QUIET_MS / 1000})
    FROM sessions s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ${sessionId} AND ${gateOf(cause)}
    ON CONFLICT (session_id) WHERE status IN ('queued', 'deferred')
    DO UPDATE SET trigger = EXCLUDED.trigger,
                  status = 'queued',
                  next_attempt_at = CASE achievement_judgments.status
                    WHEN 'deferred' THEN EXCLUDED.next_attempt_at
                    ELSE GREATEST(achievement_judgments.next_attempt_at, EXCLUDED.next_attempt_at)
                  END,
                  attempts = 0
    RETURNING id`);
  return rowsOf<{ id: string }>(queued)[0]?.id ?? null;
}

function judgeSettingsOf(settings: unknown) {
  return workspaceSettingsSchema.shape.achievement_judge.parse(
    (settings as { achievement_judge?: unknown } | null)?.achievement_judge,
  );
}

// The UTC day by the database's clock, the one leases and retries keep.
const DAY_START = sql`date_trunc('day', now(), 'UTC')`;

/**
 * What the workspace's judgment calls made since UTC midnight cost, and when
 * the next day's budget starts.
 */
async function spentToday(
  db: Database,
  workspaceId: string,
): Promise<{ spentUsd: number; budgetResetsAt: Date }> {
  const [spent] = await db
    .select({
      usd: sql<string>`COALESCE(sum(${achievementJudgmentUsage.costUsd}), 0)`,
      resetsAt: sql<string>`(${DAY_START} + interval '1 day')::text`,
    })
    .from(achievementJudgmentUsage)
    .where(
      and(
        eq(achievementJudgmentUsage.workspaceId, workspaceId),
        sql`${achievementJudgmentUsage.createdAt} >= ${DAY_START}`,
      ),
    );
  if (!spent) throw new Error("aggregate returned no row");
  return {
    spentUsd: Number(spent.usd),
    budgetResetsAt: new Date(spent.resetsAt),
  };
}

const iso = (at: Date | null) => at?.toISOString() ?? null;

function achievementOf(
  row: typeof sessionAchievements.$inferSelect,
): SessionAchievement {
  return {
    id: row.id,
    session_id: row.sessionId,
    agent_id: row.agentId,
    agent_release_id: row.agentReleaseId,
    rule_id: row.ruleId,
    rule_family_id: row.ruleFamilyId,
    type_id: row.typeId,
    title: row.title,
    link: row.link,
    evidence_kind: row.evidenceKind as AchievementEvidenceKind,
    evidence_id: row.evidenceId,
    payload: row.payload as AchievementPayload | null,
    judge: row.judge as AchievementRuleJudge,
    probability: row.probability,
    judgment_id: row.judgmentId,
    review_state: row.reviewState as AchievementReviewState,
    reviewed_by: row.reviewedBy,
    reviewed_at: iso(row.reviewedAt),
    review_note: row.reviewNote,
    created_at: row.createdAt.toISOString(),
  };
}

function judgmentOf(
  row: typeof achievementJudgments.$inferSelect,
): AchievementJudgment {
  return {
    id: row.id,
    trigger: row.trigger as AchievementJudgmentTrigger,
    status: row.status as AchievementJudgmentStatus,
    error_code: row.errorCode as AchievementJudgmentError | null,
    created_at: row.createdAt.toISOString(),
    finished_at: iso(row.finishedAt),
  };
}

function outcomeEvidenceOf(
  row: typeof sessionOutcomes.$inferSelect,
): OutcomeEvidence | null {
  const metadata = row.metadata as Record<string, unknown>;
  const count = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;
  if (row.type === "github_pull_request") {
    const number = Number(row.externalId);
    if (!Number.isSafeInteger(number)) return null;
    return {
      kind: "github_pull_request",
      id: row.id,
      url: row.url,
      number,
      state: row.state as GitHubPullRequestOutcomeState,
      mergedAt: row.mergedAt,
      additions: count(metadata.additions),
      deletions: count(metadata.deletions),
    };
  }
  const event = metadata.event as GitHubReviewEvent;
  if (
    typeof metadata.number !== "number" ||
    !GITHUB_REVIEW_EVENT_VALUES.includes(event) ||
    typeof metadata.commit_id !== "string"
  ) {
    return null;
  }
  return {
    kind: "github_review",
    id: row.id,
    url: row.url,
    number: metadata.number,
    event,
    commitId: metadata.commit_id,
  };
}

export function createPostgresAchievementJudgments(
  db: Database,
): AchievementJudgmentStore {
  return {
    async claim({ max, leaseMs }) {
      if (max <= 0) return [];
      const leaseToken = randomUUID();
      const claimed = await db
        .update(achievementJudgments)
        .set({
          status: "running",
          leaseToken,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
          attempts: sql`${achievementJudgments.attempts} + 1`,
          // A lease taken over takes the earlier holder's token with it.
          tokenHash: null,
        })
        .where(
          sql`${achievementJudgments.id} IN (SELECT ${achievementJudgments.id} FROM ${achievementJudgments} WHERE ${achievementJudgments.status} IN ('queued', 'running', 'deferred') AND ${achievementJudgments.nextAttemptAt} <= now() AND (${achievementJudgments.leaseExpiresAt} IS NULL OR ${achievementJudgments.leaseExpiresAt} < now()) ORDER BY ${achievementJudgments.nextAttemptAt} LIMIT ${max} FOR UPDATE SKIP LOCKED)`,
        )
        .returning({
          id: achievementJudgments.id,
          sessionId: achievementJudgments.sessionId,
          attempts: achievementJudgments.attempts,
        });
      return claimed.map((row) => ({ ...row, leaseToken }));
    },

    async context(judgment) {
      const [session] = await db
        .select({
          id: sessions.id,
          workspaceId: sessions.workspaceId,
          settings: workspaces.settings,
          title: sessions.title,
          agentReleaseId: sessions.agentReleaseId,
          agentId: agentReleases.agentId,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId))
        .where(eq(sessions.id, judgment.sessionId))
        .limit(1);
      if (!session?.workspaceId) {
        throw new Error("judged session has no workspace");
      }
      const agentId = session.agentId ?? null;
      const rules = await db
        .select({
          id: achievementRules.id,
          familyId: achievementRules.familyId,
          typeId: achievementRules.typeId,
          typeKey: achievementTypes.key,
          builtin: achievementTypes.builtin,
          evidenceKind: achievementTypes.evidenceKind,
          judge: achievementRules.judge,
        })
        .from(achievementRules)
        .innerJoin(
          achievementTypes,
          eq(achievementTypes.id, achievementRules.typeId),
        )
        .where(
          and(
            eq(achievementRules.workspaceId, session.workspaceId),
            isNull(achievementRules.supersededBy),
            isNull(achievementRules.disabledAt),
            agentId === null
              ? isNull(achievementRules.agentIds)
              : sql`(${achievementRules.agentIds} IS NULL OR ${agentId}::uuid = ANY(${achievementRules.agentIds}))`,
          ),
        )
        .orderBy(asc(achievementRules.createdAt), asc(achievementRules.id));
      const outcomes = await db
        .select()
        .from(sessionOutcomes)
        .where(eq(sessionOutcomes.sessionId, judgment.sessionId))
        .orderBy(asc(sessionOutcomes.createdAt), asc(sessionOutcomes.id));
      const settings = judgeSettingsOf(session.settings);
      const [called] = await db
        .select({ count: count() })
        .from(achievementJudgments)
        .where(
          and(
            eq(achievementJudgments.sessionId, judgment.sessionId),
            ne(achievementJudgments.id, judgment.id),
            gt(achievementJudgments.calls, 0),
          ),
        );
      return {
        session: {
          id: session.id,
          title: session.title,
          agentId,
          agentReleaseId: session.agentReleaseId,
        },
        judge: {
          connectionId: settings.connection_id,
          dailyBudgetUsd: settings.daily_budget_usd,
          maxPerSession: settings.max_per_session,
          ...(await spentToday(db, session.workspaceId)),
          sessionJudgments: called?.count ?? 0,
        },
        rules: rules.map((rule) => ({
          ...rule,
          evidenceKind: rule.evidenceKind as AchievementEvidenceKind,
          judge: rule.judge as AchievementRuleJudge,
        })),
        outcomes: outcomes.flatMap((row) => {
          const evidence = outcomeEvidenceOf(row);
          return evidence === null ? [] : [evidence];
        }),
      };
    },

    finish(judgment, result) {
      return db.transaction(async (tx) => {
        // Before any judgment or achievement row, as queueAchievementJudgment.
        await tx.execute(
          sql`SELECT 1 FROM sessions WHERE id = ${judgment.sessionId} FOR KEY SHARE`,
        );
        const [held] = await tx
          .select({
            workspaceId: achievementJudgments.workspaceId,
            ownerId: achievementJudgments.ownerId,
            sessionId: achievementJudgments.sessionId,
          })
          .from(achievementJudgments)
          .where(
            and(
              eq(achievementJudgments.id, judgment.id),
              eq(achievementJudgments.leaseToken, judgment.leaseToken),
            ),
          )
          .for("update");
        if (!held) return false;
        const done = {
          errorCode: result.errorCode,
          rules: result.rules,
          evidenceIds: result.evidenceIds,
          leaseToken: null,
          leaseExpiresAt: null,
          tokenHash: null,
        };
        const self = eq(achievementJudgments.id, judgment.id);
        // A session has one pending judgment: a newer trigger's waits for
        // the retry or the next day too, and judges everything this one would.
        const fold = async (at: SQL, deferred: boolean) => {
          const [other] = await tx
            .update(achievementJudgments)
            .set({
              nextAttemptAt: sql`GREATEST(${achievementJudgments.nextAttemptAt}, ${at})`,
              ...(deferred ? { status: "deferred", attempts: 0 } : {}),
            })
            .where(
              and(
                eq(achievementJudgments.sessionId, held.sessionId),
                inArray(achievementJudgments.status, ["queued", "deferred"]),
              ),
            )
            .returning({ id: achievementJudgments.id });
          return other !== undefined;
        };
        const end = (status: "succeeded" | "skipped" | "failed") =>
          tx
            .update(achievementJudgments)
            .set({ ...done, status, finishedAt: sql`now()` })
            .where(self);
        if (result.status !== "queued" && result.status !== "deferred") {
          await end(result.status);
        } else {
          const deferred = result.status === "deferred";
          const at =
            result.status === "deferred"
              ? sql`${result.until.toISOString()}::timestamptz`
              : sql`clock_timestamp() + make_interval(secs => ${result.retryInMs / 1000})`;
          let requeued = false;
          if (!(await fold(at, deferred))) {
            // A trigger committing meanwhile takes the pending slot first.
            requeued = await tx
              .transaction(async (savepoint) => {
                await savepoint
                  .update(achievementJudgments)
                  .set({
                    ...done,
                    status: result.status,
                    nextAttemptAt: at,
                    // A day's wait is not a failed try.
                    ...(deferred ? { attempts: 0 } : {}),
                  })
                  .where(self);
                return true;
              })
              .catch((error: unknown) => {
                if (findPgError(error, "23505")) return false;
                throw error;
              });
            if (!requeued) await fold(at, deferred);
          }
          if (!requeued) await end("failed");
        }
        if (result.achievements.length > 0) {
          // A family's achievement for the evidence stays as it is, and so
          // does whatever a person decided about it.
          await tx
            .insert(sessionAchievements)
            .values(
              result.achievements.map((achievement) => ({
                id: randomUUID(),
                workspaceId: held.workspaceId,
                ownerId: held.ownerId,
                sessionId: held.sessionId,
                agentId: achievement.agentId,
                agentReleaseId: achievement.agentReleaseId,
                ruleId: achievement.ruleId,
                ruleFamilyId: achievement.ruleFamilyId,
                typeId: achievement.typeId,
                title: achievement.title,
                link: achievement.link,
                evidenceKind: achievement.evidenceKind,
                evidenceId: achievement.evidenceId,
                payload: achievement.payload,
                judge: achievement.judge,
                probability: null,
                judgmentId: judgment.id,
                reviewState: achievement.reviewState,
              })),
            )
            .onConflictDoNothing();
        }
        return true;
      });
    },

    rejudge({ actor, sessionId, receiptId }) {
      return db.transaction(async (tx) => {
        if (!(await managing(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [session] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, sessionId),
              eq(sessions.ownerId, actor.principal.ownerId),
              eq(sessions.workspaceId, actor.workspaceId),
            ),
          )
          .limit(1);
        if (!session) return { outcome: "not_found" as const };
        const judgmentId = await queueAchievementJudgment(tx, sessionId, {
          trigger: "manual",
        });
        if (judgmentId === null) return { outcome: "not_found" as const };
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: actor.principal.ownerId,
          actor: receiptActorOf(actor.principal),
          operation: "rejudge_session",
          targetRef: { session_id: sessionId, turn_id: null, request_id: null },
          result: { judgment_id: judgmentId },
          status: "succeeded",
          requestId: actor.principal.requestId ?? null,
        });
        return { outcome: "queued" as const, judgmentId };
      });
    },

    async list(ownerId, rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId)))
        .limit(1);
      if (!session) return null;
      const items = await db
        .select()
        .from(sessionAchievements)
        .where(
          and(
            eq(sessionAchievements.sessionId, sessionId),
            isNull(sessionAchievements.supersededAt),
          ),
        )
        .orderBy(
          asc(sessionAchievements.createdAt),
          asc(sessionAchievements.id),
        );
      const [latest] = await db
        .select()
        .from(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, sessionId))
        .orderBy(
          desc(achievementJudgments.createdAt),
          desc(achievementJudgments.id),
        )
        .limit(1);
      return {
        items: items.map(achievementOf),
        judgment: latest ? judgmentOf(latest) : null,
      };
    },
  };
}

/** The judgment egress token and its ledger (achievement-rules.md §4). */
export function createPostgresJudgmentEgress(
  db: Database,
): JudgmentEgressStore {
  return {
    async issueToken(judgment, tokenHash) {
      const issued = await db
        .update(achievementJudgments)
        .set({ tokenHash })
        .where(
          and(
            eq(achievementJudgments.id, judgment.id),
            eq(achievementJudgments.leaseToken, judgment.leaseToken),
            eq(achievementJudgments.status, "running"),
            sql`${achievementJudgments.leaseExpiresAt} > now()`,
          ),
        )
        .returning({ id: achievementJudgments.id });
      return issued.length > 0;
    },

    async authorizeToken({ tokenHash }) {
      const [held] = await db
        .select({
          id: achievementJudgments.id,
          workspaceId: achievementJudgments.workspaceId,
          settings: workspaces.settings,
        })
        .from(achievementJudgments)
        .innerJoin(
          workspaces,
          eq(workspaces.id, achievementJudgments.workspaceId),
        )
        .where(
          and(
            eq(achievementJudgments.tokenHash, tokenHash),
            eq(achievementJudgments.status, "running"),
            sql`${achievementJudgments.leaseExpiresAt} > now()`,
          ),
        )
        .limit(1);
      if (!held) return { outcome: "invalid_token" };
      const settings = judgeSettingsOf(held.settings);
      return {
        outcome: "ok",
        judgmentId: held.id,
        connectionId: settings.connection_id,
        dailyBudgetUsd: settings.daily_budget_usd,
        spentUsd: (await spentToday(db, held.workspaceId)).spentUsd,
      };
    },

    recordUsage({ exchangeId, judgmentId, inputTokens, costUsd }) {
      return db.transaction(async (tx) => {
        const [judgment] = await tx
          .select({
            sessionId: achievementJudgments.sessionId,
            workspaceId: achievementJudgments.workspaceId,
          })
          .from(achievementJudgments)
          .where(eq(achievementJudgments.id, judgmentId))
          .limit(1);
        if (!judgment) return { outcome: "unknown_judgment" as const };
        // Before the judgment row, as queueAchievementJudgment.
        await tx.execute(
          sql`SELECT 1 FROM sessions WHERE id = ${judgment.sessionId} FOR KEY SHARE`,
        );
        // Whole micro-dollars, rounded up like a session's spend.
        const [inserted] = await tx
          .insert(achievementJudgmentUsage)
          .values({
            exchangeId,
            judgmentId,
            workspaceId: judgment.workspaceId,
            inputTokens,
            costUsd: sql`ceil(${costUsd}::numeric * 1000000) / 1000000`,
          })
          .onConflictDoNothing({ target: achievementJudgmentUsage.exchangeId })
          .returning({ costUsd: achievementJudgmentUsage.costUsd });
        if (inserted === undefined) {
          // The proxy reports an exchange again when no answer came back.
          const [stored] = await tx
            .select({
              judgmentId: achievementJudgmentUsage.judgmentId,
              inputTokens: achievementJudgmentUsage.inputTokens,
              costUsd: achievementJudgmentUsage.costUsd,
            })
            .from(achievementJudgmentUsage)
            .where(eq(achievementJudgmentUsage.exchangeId, exchangeId));
          return stored?.judgmentId === judgmentId &&
            stored.inputTokens === inputTokens
            ? { outcome: "replayed" as const, costUsd: stored.costUsd }
            : { outcome: "conflict" as const };
        }
        await tx
          .update(achievementJudgments)
          .set({
            calls: sql`${achievementJudgments.calls} + 1`,
            inputTokens: sql`${achievementJudgments.inputTokens} + ${inputTokens}`,
            costUsd: sql`${achievementJudgments.costUsd} + ${inserted.costUsd}::numeric`,
          })
          .where(eq(achievementJudgments.id, judgmentId));
        return { outcome: "recorded" as const, costUsd: inserted.costUsd };
      });
    },
  };
}

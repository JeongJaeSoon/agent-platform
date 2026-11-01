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
} from "@werft-ai/contracts";
import {
  ACHIEVEMENT_JUDGMENT_QUIET_MS,
  type AchievementJudgmentStore,
  type OutcomeEvidence,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  achievementJudgments,
  achievementRules,
  achievementTypes,
  agentReleases,
  sessionAchievements,
  sessionOutcomes,
  sessions,
} from "./schema.ts";

/**
 * Queues an `evidence` judgment of the session, in the transaction that wrote
 * its evidence (achievement-rules.md §4). A queued one already there is kept
 * and waits the quiet time again from now, never less than it already
 * waits. Nothing is queued for a session without a workspace, or when the
 * workspace turned `on_evidence` off.
 */
export async function queueAchievementJudgment(
  tx: Database,
  sessionId: string,
): Promise<void> {
  // The session row is locked before the queued index entry is taken, the
  // order a checkpoint commit's fence (FOR UPDATE) takes them in; the other
  // order deadlocks against it on the index and the foreign key.
  await tx.execute(
    sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR KEY SHARE`,
  );
  // clock_timestamp: a long transaction must not queue in its own past.
  await tx.execute(sql`
    INSERT INTO achievement_judgments
      (id, workspace_id, owner_id, session_id, trigger, status, next_attempt_at)
    SELECT ${randomUUID()}, s.workspace_id, s.owner_id, s.id, 'evidence', 'queued',
           clock_timestamp() + make_interval(secs => ${ACHIEVEMENT_JUDGMENT_QUIET_MS / 1000})
    FROM sessions s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ${sessionId}
      AND (w.settings -> 'achievement_judge' -> 'on_evidence') IS DISTINCT FROM 'false'::jsonb
    ON CONFLICT (session_id) WHERE status = 'queued'
    DO UPDATE SET next_attempt_at = GREATEST(achievement_judgments.next_attempt_at, EXCLUDED.next_attempt_at)`);
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
        })
        .where(
          sql`${achievementJudgments.id} IN (SELECT ${achievementJudgments.id} FROM ${achievementJudgments} WHERE ${achievementJudgments.status} IN ('queued', 'running') AND ${achievementJudgments.nextAttemptAt} <= now() AND (${achievementJudgments.leaseExpiresAt} IS NULL OR ${achievementJudgments.leaseExpiresAt} < now()) ORDER BY ${achievementJudgments.nextAttemptAt} LIMIT ${max} FOR UPDATE SKIP LOCKED)`,
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
          title: sessions.title,
          agentReleaseId: sessions.agentReleaseId,
          agentId: agentReleases.agentId,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
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
      return {
        session: {
          id: session.id,
          title: session.title,
          agentId,
          agentReleaseId: session.agentReleaseId,
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
        let status = result.status;
        let nextAttemptAt: SQL | undefined;
        if (result.status === "queued") {
          const at = sql`clock_timestamp() + make_interval(secs => ${result.retryInMs / 1000})`;
          // A session has one queued judgment: a newer trigger's waits
          // for the retry too, and judges everything this one would.
          const [other] = await tx
            .update(achievementJudgments)
            .set({
              nextAttemptAt: sql`GREATEST(${achievementJudgments.nextAttemptAt}, ${at})`,
            })
            .where(
              and(
                eq(achievementJudgments.sessionId, held.sessionId),
                eq(achievementJudgments.status, "queued"),
              ),
            )
            .returning({ id: achievementJudgments.id });
          if (other) status = "failed";
          else nextAttemptAt = at;
        }
        await tx
          .update(achievementJudgments)
          .set({
            status,
            errorCode: result.errorCode,
            rules: result.rules,
            evidenceIds: result.evidenceIds,
            leaseToken: null,
            leaseExpiresAt: null,
            ...(nextAttemptAt === undefined
              ? { finishedAt: sql`now()` }
              : { nextAttemptAt }),
          })
          .where(eq(achievementJudgments.id, judgment.id));
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

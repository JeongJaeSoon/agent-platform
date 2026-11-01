import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AchievementRuleJudge,
  listSessionAchievementsResponseSchema,
  type ReceiptActor,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  type AchievementJudgmentStore,
  type ClaimedJudgment,
  callerFor,
  createAchievementJudge,
  type SessionOutputsResult,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresAchievementJudgments,
  queueAchievementJudgment,
} from "./achievement-judgments.ts";
import {
  createPostgresAchievementRuleStore,
  insertBuiltinAchievementTypes,
} from "./achievement-rules.ts";
import { findPgError } from "./control-shared.ts";
import { createPostgresGitHubGateStore } from "./github-settings.ts";
import {
  createPostgresPullRequests,
  insertPullRequestOutcome,
} from "./pull-requests.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import {
  achievementJudgments,
  achievementTypes,
  attempts,
  memberships,
  receipts,
  sessionAchievements,
  sessionOutcomes,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSessionOutcomes } from "./session-outcomes.ts";
import { commitCheckpoint } from "./testing/checkpoints.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const HUMAN: ReceiptActor = {
  principal: { kind: "api_key", id: "key-achievements" },
  actor_user_id: null,
  agent_id: null,
};

integration("achievement judgments on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let judgments: AchievementJudgmentStore;
  const outputsBySession = new Map<string, SessionOutputsResult>();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "achievement_judgments_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    judgments = createPostgresAchievementJudgments(db);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const rules = () => createPostgresAchievementRuleStore(db);

  /** A workspace with its built-in types and an owner who manages rules. */
  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `acme-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    await insertBuiltinAchievementTypes(db, workspaceId);
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    const caller = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
    const owner: TeamActor = { principal: caller, workspaceId, userId };
    const created = await rules().createCategory({
      actor: owner,
      receiptId: randomUUID(),
      name: "Delivery",
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return { workspaceId, owner, categoryId: created.category.id };
  }

  async function typeId(workspaceId: string, typeKey: string) {
    const [row] = await db
      .select({ id: achievementTypes.id })
      .from(achievementTypes)
      .where(
        and(
          eq(achievementTypes.workspaceId, workspaceId),
          eq(achievementTypes.key, typeKey),
        ),
      );
    if (!row) throw new Error(`no type ${typeKey}`);
    return row.id;
  }

  async function personType(
    ws: Awaited<ReturnType<typeof workspace>>,
    evidenceKind: "github_pull_request" | "github_review",
  ) {
    const created = await rules().createType({
      actor: ws.owner,
      receiptId: randomUUID(),
      key: `custom_${randomUUID().slice(0, 6)}`,
      name: "Custom",
      evidenceKind,
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return created.type.id;
  }

  async function rule(
    ws: Awaited<ReturnType<typeof workspace>>,
    type: string,
    judge: AchievementRuleJudge = "always",
  ) {
    const created = await rules().createRule({
      actor: ws.owner,
      receiptId: randomUUID(),
      rule: {
        category_id: ws.categoryId,
        title: "Counted",
        type_id: type,
        definition: "Counts as it appears.",
        judge,
        agent_ids: null,
      },
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    return created.rule;
  }

  /** A claimed session of the workspace, ready for checkpoint commits. */
  async function session(workspaceId: string | null, title?: string) {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: workspaceId ?? "owner-legacy",
      workspaceId,
      repoUrl: "https://github.com/acme/app.git",
      branch: `agent/${id}`,
      repositoryId: "app",
      title: title ?? null,
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
    });
    return id;
  }

  async function receipt(ownerId: string, sessionId: string) {
    const id = randomUUID();
    await db.insert(receipts).values({
      id,
      ownerId,
      operation: "open_pull_request",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "succeeded",
      result: {},
      error: null,
      actor: HUMAN,
    });
    return id;
  }

  let nextNumber = 10;
  /** A pull request outcome written as the PR service writes it. */
  async function pullRequest(sessionId: string, ownerId: string) {
    nextNumber += 1;
    const url = `https://github.com/acme/app/pull/${nextNumber}`;
    const receiptId = await receipt(ownerId, sessionId);
    await db.transaction((tx) =>
      insertPullRequestOutcome(tx, {
        ownerId,
        sessionId,
        url,
        repositoryId: "app",
        number: nextNumber,
        title: "Retry failed payments",
        head: `agent/${sessionId}`,
        base: "main",
        adopted: false,
        receiptId,
        createdAt: new Date(),
      }),
    );
    const [row] = await db
      .select()
      .from(sessionOutcomes)
      .where(eq(sessionOutcomes.url, url));
    if (!row) throw new Error("no outcome");
    return row;
  }

  async function review(sessionId: string, ownerId: string, number = 9) {
    const reviewId = Math.floor(Math.random() * 1_000_000_000);
    await createPostgresGitHubGateStore(db).recordReview({
      context: {
        ownerId,
        sessionId,
        agentId: null,
        agentReleaseId: null,
        repositoryId: "app",
      },
      actor: HUMAN,
      result: { number, event: "APPROVE", review_id: reviewId },
      review: {
        id: reviewId,
        url: `https://github.com/acme/app/pull/${number}#pullrequestreview-${reviewId}`,
      },
      metadata: {
        number,
        event: "APPROVE",
        commit_id: "c".repeat(40),
        opened_by_session_id: null,
      },
    });
  }

  async function judgmentsOf(sessionId: string) {
    return db
      .select()
      .from(achievementJudgments)
      .where(eq(achievementJudgments.sessionId, sessionId))
      .orderBy(achievementJudgments.createdAt);
  }

  async function achievementsOf(sessionId: string) {
    return db
      .select()
      .from(sessionAchievements)
      .where(eq(sessionAchievements.sessionId, sessionId))
      .orderBy(sessionAchievements.createdAt, sessionAchievements.title);
  }

  /** As if the quiet time had passed since the session's last trigger. */
  async function quietPassed(sessionId: string) {
    await db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(
        and(
          eq(achievementJudgments.sessionId, sessionId),
          eq(achievementJudgments.status, "queued"),
        ),
      );
  }

  function replica(claimMax?: number) {
    return createAchievementJudge({
      store: judgments,
      outputs: {
        readOutputs: async (sessionId) =>
          outputsBySession.get(sessionId) ?? { status: "none" },
      },
      logger: { info() {}, warn() {} },
      ...(claimMax === undefined ? {} : { claimMax }),
    });
  }

  test("opening a pull request queues an evidence judgment in its own transaction; a review merges into it", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    await db
      .update(sessions)
      .set({ checkpointRevision: 1 })
      .where(eq(sessions.id, sessionId));
    const pushes = createPostgresPushRequests(db);
    const created = await pushes.create({
      ownerId: workspaceId,
      sessionId,
      actor: HUMAN,
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: "app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: "c".repeat(40),
      approvedByRelease: null,
    });
    if (created.outcome !== "written") throw new Error("no push request");
    await createPostgresPullRequests(db).savePullRequest({
      ownerId: workspaceId,
      sessionId,
      pushRequestId: created.request.id,
      actor: HUMAN,
      repositoryId: "app",
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      title: "Retry failed payments",
      head: `agent/${sessionId}`,
      base: "main",
      created: true,
    });
    const [opened, ...none] = await judgmentsOf(sessionId);
    expect(none).toEqual([]);
    expect(opened).toMatchObject({
      workspaceId,
      ownerId: workspaceId,
      trigger: "evidence",
      status: "queued",
      attempts: 0,
    });
    const { rows: waits } = await pool.query(
      "SELECT next_attempt_at > now() + interval '100 seconds' AS later FROM achievement_judgments WHERE id = $1",
      [opened?.id],
    );
    expect(waits[0].later).toBe(true);

    await review(sessionId, workspaceId);
    const merged = await judgmentsOf(sessionId);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(opened?.id);
    expect(merged[0]?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      opened?.nextAttemptAt.getTime() ?? Number.POSITIVE_INFINITY,
    );

    // The judgment commits with its evidence or not at all.
    const other = await session(workspaceId);
    const receiptId = await receipt(workspaceId, other);
    await expect(
      db.transaction(async (tx) => {
        await insertPullRequestOutcome(tx, {
          ownerId: workspaceId,
          sessionId: other,
          url: "https://github.com/acme/app/pull/6",
          repositoryId: "app",
          number: 6,
          title: null,
          head: `agent/${other}`,
          base: "main",
          adopted: false,
          receiptId,
          createdAt: new Date(),
        });
        const inside = await tx
          .select({ id: achievementJudgments.id })
          .from(achievementJudgments)
          .where(eq(achievementJudgments.sessionId, other));
        expect(inside).toHaveLength(1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await judgmentsOf(other)).toEqual([]);
  });

  test("a refresher read that changes a pull request's state queues a judgment; one that does not, queues none", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    const row = await pullRequest(sessionId, workspaceId);
    // Judged already: nothing queued.
    await db
      .delete(achievementJudgments)
      .where(eq(achievementJudgments.sessionId, sessionId));
    const outcomes = createPostgresSessionOutcomes(db);
    const lease = async () => {
      const leaseToken = randomUUID();
      await db
        .update(sessionOutcomes)
        .set({ leaseToken, leaseExpiresAt: sql`now() + interval '1 minute'` })
        .where(eq(sessionOutcomes.id, row.id));
      return {
        id: row.id,
        sessionId,
        repositoryId: "app",
        number: Number(row.externalId),
        state: "open" as const,
        leaseToken,
      };
    };
    const metadata = {
      title: "Retry failed payments",
      merge_commit_sha: null,
      additions: 2,
      deletions: 1,
      changed_files: 1,
      commits: 1,
    };
    expect(
      await outcomes.finish(await lease(), {
        kind: "state",
        state: "open",
        mergedAt: null,
        closedAt: null,
        metadata,
      }),
    ).toBe(true);
    expect(await judgmentsOf(sessionId)).toEqual([]);

    const at = new Date();
    expect(
      await outcomes.finish(await lease(), {
        kind: "state",
        state: "merged",
        mergedAt: at,
        closedAt: at,
        metadata: { ...metadata, merge_commit_sha: "d".repeat(40) },
      }),
    ).toBe(true);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { trigger: "evidence", status: "queued" },
    ]);
  });

  test("a checkpoint listing out/ files queues a judgment; one listing none does not", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    const attemptId = `attempt-${randomUUID()}`;
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: 1,
      executionId: `exec-${attemptId}`,
      id: attemptId,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 600_000),
      sessionId,
      state: "running",
    });
    const commit = (
      revision: number,
      outputs: { key: string; bytes: number }[],
    ) =>
      commitCheckpoint(db, {
        checkpoint: {
          revision,
          manifest_ref: `sessions/${sessionId}/checkpoints/${revision}/${attemptId}/manifest.json`,
          manifest_sha256: "a".repeat(64),
        },
        fence: {
          attemptId,
          authRevision: 1,
          executionGeneration: 1,
          leaseEpoch: 1,
          sessionId,
        },
        now: new Date(),
        sessionId,
        turnId: null,
        outputs,
      });
    expect(await commit(0, [])).toEqual({ outcome: "committed", revision: 0 });
    expect(await judgmentsOf(sessionId)).toEqual([]);
    expect(
      await commit(1, [
        {
          key: `sessions/${sessionId}/checkpoints/1/${attemptId}/outputs/${"b".repeat(64)}`,
          bytes: 42,
        },
      ]),
    ).toEqual({ outcome: "committed", revision: 1 });
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { trigger: "evidence", status: "queued" },
    ]);
  });

  test("nothing is queued for a workspace that turned on_evidence off, or for a session without a workspace", async () => {
    const { workspaceId } = await workspace();
    await db
      .update(workspaces)
      .set({
        settings: sql`jsonb_build_object('achievement_judge', jsonb_build_object('on_evidence', false))`,
      })
      .where(eq(workspaces.id, workspaceId));
    const off = await session(workspaceId);
    await review(off, workspaceId);
    expect(await judgmentsOf(off)).toEqual([]);

    const legacy = await session(null);
    await queueAchievementJudgment(db, legacy);
    expect(await judgmentsOf(legacy)).toEqual([]);
  });

  test("the judge waits out the quiet time, then writes each always rule's achievements with the payload and review state of their evidence", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const reviewed = await personType(ws, "github_review");
    await rule(ws, reviewed);
    const sessionId = await session(ws.workspaceId, "Fix the payments");
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await review(sessionId, ws.workspaceId);
    outputsBySession.set(sessionId, {
      status: "ready",
      revision: 1,
      outputs: [
        {
          path: "out/report.md",
          bytes: 42,
          sha256: "b".repeat(64),
          key: `sessions/${sessionId}/outputs/${"b".repeat(64)}`,
        },
      ],
    });

    await replica().runOnce();
    expect(await judgmentsOf(sessionId)).toMatchObject([{ status: "queued" }]);
    expect(await achievementsOf(sessionId)).toEqual([]);

    await quietPassed(sessionId);
    await replica().runOnce();
    const [judgment] = await judgmentsOf(sessionId);
    expect(judgment).toMatchObject({
      status: "succeeded",
      errorCode: null,
      attempts: 1,
      leaseToken: null,
      leaseExpiresAt: null,
      calls: 0,
      costUsd: 0,
    });
    expect(judgment?.finishedAt).not.toBeNull();
    expect(judgment?.rules).toHaveLength(3);
    expect(judgment?.evidenceIds).toContain(pr.id);
    expect(judgment?.evidenceIds).toContain("out/report.md");

    const written = await achievementsOf(sessionId);
    const byKind = Object.fromEntries(
      written.map((row) => [row.evidenceKind, row]),
    );
    expect(written).toHaveLength(3);
    expect(byKind.github_pull_request).toMatchObject({
      title: `acme/app#${pr.externalId}`,
      link: pr.url,
      evidenceId: pr.id,
      judge: "always",
      probability: null,
      reviewState: "auto",
      judgmentId: judgment?.id,
      payload: {
        repository: "acme/app",
        number: Number(pr.externalId),
        url: pr.url,
        state: "open",
        merged_at: null,
        additions: null,
        deletions: null,
      },
    });
    expect(byKind.github_review).toMatchObject({
      title: "acme/app#9",
      typeId: reviewed,
      payload: null,
      reviewState: "auto",
    });
    expect(byKind.out_file).toMatchObject({
      title: "out/report.md",
      evidenceId: "out/report.md",
      link: `/v1/sessions/${sessionId}/outputs/out%2Freport.md`,
      payload: { path: "out/report.md", size: 42 },
      reviewState: "needs_review",
    });

    const listed = await judgments.list(ws.workspaceId, sessionId);
    if (listed === null) throw new Error("not listed");
    expect(listSessionAchievementsResponseSchema.parse(listed)).toEqual(listed);
    expect(listed?.items).toHaveLength(3);
    expect(listed?.judgment).toMatchObject({
      id: judgment?.id,
      trigger: "evidence",
      status: "succeeded",
      error_code: null,
    });
    expect(await judgments.list("another-owner", sessionId)).toBeNull();
  });

  test("duplicate triggers and a rule's next version never count a family's evidence twice", async () => {
    const ws = await workspace();
    const first = await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    await replica().runOnce();
    expect(await achievementsOf(sessionId)).toHaveLength(1);

    const edited = await rules().createRuleVersion({
      actor: ws.owner,
      receiptId: randomUUID(),
      familyId: first.family_id,
      rule: {
        category_id: ws.categoryId,
        title: "Counted, renamed",
        type_id: first.type_id,
        definition: "Counts as it appears.",
        judge: "always",
        agent_ids: null,
      },
    });
    expect(edited.outcome).toBe("created");
    for (let trigger = 0; trigger < 2; trigger += 1) {
      await queueAchievementJudgment(db, sessionId);
      await quietPassed(sessionId);
      await replica().runOnce();
    }
    const statuses = (await judgmentsOf(sessionId)).map((row) => row.status);
    expect(statuses).toEqual(["succeeded", "succeeded", "succeeded"]);
    const written = await achievementsOf(sessionId);
    expect(written).toHaveLength(1);
    expect(written[0]?.ruleId).toBe(first.id);
    expect(written[0]?.evidenceId).toBe(pr.id);

    // The index itself refuses a second live row for the family and evidence.
    const [judgment] = await judgmentsOf(sessionId);
    const duplicate = db.insert(sessionAchievements).values({
      ...(written[0] as typeof sessionAchievements.$inferInsert),
      id: randomUUID(),
      judgmentId: judgment?.id ?? "",
    });
    const error = await duplicate.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(findPgError(error, "23505")).toBeDefined();
  });

  test("with only luna rules and no judge, the judgment is skipped and nothing is counted", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"), "luna");
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    await replica().runOnce();
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "skipped", errorCode: "judge_unavailable" },
    ]);
    expect(await achievementsOf(sessionId)).toEqual([]);
    const listed = await judgments.list(ws.workspaceId, sessionId);
    expect(listed?.judgment).toMatchObject({
      status: "skipped",
      error_code: "judge_unavailable",
    });
  });

  test("a claimed judgment is not claimed again within its lease; after a takeover the late finish writes nothing", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    const sessionId = await session(ws.workspaceId);
    await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const ours = (claimed: ClaimedJudgment[]) =>
      claimed.filter((row) => row.sessionId === sessionId);

    const [first] = ours(await judgments.claim({ max: 100, leaseMs: 60_000 }));
    if (!first) throw new Error("not claimed");
    expect(ours(await judgments.claim({ max: 100, leaseMs: 60_000 }))).toEqual(
      [],
    );
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "running", attempts: 1 },
    ]);

    // The first replica died: its lease runs out and another takes it.
    await db
      .update(achievementJudgments)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(achievementJudgments.id, first.id));
    const [second] = ours(await judgments.claim({ max: 100, leaseMs: 60_000 }));
    expect(second?.id).toBe(first.id);
    expect(second?.leaseToken).not.toBe(first.leaseToken);

    const late = {
      status: "succeeded" as const,
      errorCode: null,
      rules: [],
      evidenceIds: [],
      achievements: [],
    };
    expect(await judgments.finish(first, late)).toBe(false);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "running", attempts: 2 },
    ]);
    // Held by the second claim: a pass leaves it alone.
    await replica().runOnce();
    expect(await achievementsOf(sessionId)).toEqual([]);

    await db
      .update(achievementJudgments)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(achievementJudgments.id, first.id));
    await replica().runOnce();
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "succeeded", attempts: 3 },
    ]);
    expect(await achievementsOf(sessionId)).toHaveLength(1);
  });

  test("two replicas judging at once judge every judgment once and count each evidence once", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    const sessionIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const sessionId = await session(ws.workspaceId);
      await pullRequest(sessionId, ws.workspaceId);
      await quietPassed(sessionId);
      sessionIds.push(sessionId);
    }
    const left = async () => {
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM achievement_judgments WHERE session_id = ANY($1::uuid[]) AND status <> 'succeeded'",
        [sessionIds],
      );
      return rows[0].n as number;
    };
    const a = replica(3);
    const b = replica(3);
    for (let pass = 0; pass < 10 && (await left()) > 0; pass += 1) {
      await Promise.all([a.runOnce(), b.runOnce()]);
    }
    expect(await left()).toBe(0);
    const { rows } = await pool.query(
      `SELECT j.session_id, j.attempts, count(a.id)::int AS achievements
       FROM achievement_judgments j
       LEFT JOIN session_achievements a ON a.judgment_id = j.id
       WHERE j.session_id = ANY($1::uuid[])
       GROUP BY j.id`,
      [sessionIds],
    );
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row).toMatchObject({ attempts: 1, achievements: 1 });
    }
  });
});

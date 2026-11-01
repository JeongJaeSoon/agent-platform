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
  checkpointOutputObjects,
  checkpointOutputsDigest,
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
import { acquireFence } from "./fence.ts";
import { createPostgresGitHubGateStore } from "./github-settings.ts";
import {
  createPostgresPullRequests,
  insertPullRequestOutcome,
} from "./pull-requests.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import type { Database } from "./queries.ts";
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
import { advanceCheckpointPointer } from "./worker-unit-of-work.ts";

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
    expect(merged[0]?.nextAttemptAt.getTime()).toBeGreaterThan(
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

  test("a merge never moves the wait back: not from a long transaction, not below a later deadline", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    const deadline = async () =>
      (await judgmentsOf(sessionId))[0]?.nextAttemptAt.getTime() ?? 0;

    // A transaction that began before another trigger queues after it.
    let begun: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    let proceed: () => void = () => {};
    const go = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const slow = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT now()`);
      begun();
      await go;
      await queueAchievementJudgment(tx, sessionId);
    });
    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await queueAchievementJudgment(db, sessionId);
    const meanwhile = await deadline();
    await new Promise((resolve) => setTimeout(resolve, 50));
    proceed();
    await slow;
    expect(await deadline()).toBeGreaterThan(meanwhile);

    // A later deadline (a retry's) is kept.
    await db
      .update(achievementJudgments)
      .set({ nextAttemptAt: sql`now() + interval '1 hour'` })
      .where(eq(achievementJudgments.sessionId, sessionId));
    const later = await deadline();
    await queueAchievementJudgment(db, sessionId);
    expect(await deadline()).toBe(later);
  });

  test("the session row is locked before the queued entry, so a checkpoint's fence and a refresher's queue do not deadlock", async () => {
    const { workspaceId } = await workspace();
    const sessionId = await session(workspaceId);
    let fenced: () => void = () => {};
    const locked = new Promise<void>((resolve) => {
      fenced = resolve;
    });
    let proceed: () => void = () => {};
    const go = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    // As a checkpoint commit: the fence locks the session, then it queues.
    const checkpoint = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR UPDATE`,
      );
      fenced();
      await go;
      await queueAchievementJudgment(tx, sessionId);
    });
    await locked;
    // As the refresher: queues with no lock of its own first.
    const refresher = db.transaction((tx) =>
      queueAchievementJudgment(tx, sessionId),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    proceed();
    const results = await Promise.allSettled([checkpoint, refresher]);
    expect(
      results.map((result) =>
        result.status === "rejected"
          ? findPgError(result.reason, "40P01")
            ? "deadlock"
            : "error"
          : "ok",
      ),
    ).toEqual(["ok", "ok"]);
    expect((await judgmentsOf(sessionId)).map((row) => row.status)).toEqual([
      "queued",
    ]);
  });

  /** A claimed judgment of a session with a pull request, and its retry. */
  async function claimedRetry() {
    const ws = await workspace();
    const counted = await rule(
      ws,
      await typeId(ws.workspaceId, "pull_request"),
    );
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    await quietPassed(sessionId);
    const [claimed] = (
      await judgments.claim({ max: 100, leaseMs: 60_000 })
    ).filter((row) => row.sessionId === sessionId);
    if (!claimed) throw new Error("not claimed");
    const retry = {
      status: "queued" as const,
      retryInMs: 60_000,
      errorCode: "outputs_unavailable" as const,
      rules: [counted.id],
      evidenceIds: [pr.id],
      achievements: [
        {
          ruleId: counted.id,
          ruleFamilyId: counted.family_id,
          typeId: counted.type_id,
          agentId: null,
          agentReleaseId: null,
          title: "acme/app#pr",
          link: pr.url,
          evidenceKind: "github_pull_request" as const,
          evidenceId: pr.id,
          payload: null,
          judge: "always" as const,
          reviewState: "auto" as const,
        },
      ],
    };
    return { sessionId, claimed, retry };
  }

  /** Runs `body`, waits for `release`, runs `after`, then commits. */
  function held(
    body: (tx: Database) => Promise<void>,
    after: (tx: Database) => Promise<void> = async () => {},
  ) {
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release: () => void = () => {};
    const go = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = db.transaction(async (tx) => {
      await body(tx);
      ready();
      await go;
      await after(tx);
    });
    return { started, release, done };
  }

  test("a retry folds into a judgment a trigger queued meanwhile, committed before or while it finishes", async () => {
    // Committed before: the retry's wait moves onto the queued one.
    const before = await claimedRetry();
    await queueAchievementJudgment(db, before.sessionId);
    expect(await judgments.finish(before.claimed, before.retry)).toBe(true);
    const folded = await judgmentsOf(before.sessionId);
    expect(folded.map((row) => [row.status, row.errorCode])).toEqual([
      ["failed", "outputs_unavailable"],
      ["queued", null],
    ]);
    expect(folded[1]?.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 50_000,
    );
    expect(await achievementsOf(before.sessionId)).toHaveLength(1);

    // Still uncommitted when the retry looks: it takes the queued slot first.
    const during = await claimedRetry();
    const trigger = held((tx) =>
      queueAchievementJudgment(tx, during.sessionId),
    );
    await trigger.started;
    const finishing = judgments.finish(during.claimed, during.retry);
    await new Promise((resolve) => setTimeout(resolve, 200));
    trigger.release();
    await trigger.done;
    expect(await finishing).toBe(true);
    const raced = await judgmentsOf(during.sessionId);
    expect(raced.map((row) => row.status)).toEqual(["failed", "queued"]);
    expect(raced[1]?.nextAttemptAt.getTime()).toBeGreaterThan(
      Date.now() + 50_000,
    );
    expect(await achievementsOf(during.sessionId)).toHaveLength(1);
  });

  test("a retry's finish and a checkpoint's fence and queue do not deadlock", async () => {
    const { sessionId, claimed, retry } = await claimedRetry();
    // As a checkpoint commit: the fence locks the session, then it queues.
    const checkpoint = held(
      (tx) =>
        tx
          .execute(
            sql`SELECT 1 FROM sessions WHERE id = ${sessionId} FOR UPDATE`,
          )
          .then(() => {}),
      (tx) => queueAchievementJudgment(tx, sessionId),
    );
    await checkpoint.started;
    const finishing = judgments.finish(claimed, retry);
    await new Promise((resolve) => setTimeout(resolve, 200));
    checkpoint.release();
    const results = await Promise.allSettled([checkpoint.done, finishing]);
    expect(
      results.map((result) =>
        result.status === "rejected"
          ? findPgError(result.reason, "40P01")
            ? "deadlock"
            : "error"
          : "ok",
      ),
    ).toEqual(["ok", "ok"]);
    expect(await achievementsOf(sessionId)).toHaveLength(1);
  });

  test("new evidence makes a waiting retry a first try again", async () => {
    const { sessionId, claimed, retry } = await claimedRetry();
    expect(await judgments.finish(claimed, retry)).toBe(true);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "queued", attempts: 1 },
    ]);
    await queueAchievementJudgment(db, sessionId);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "queued", attempts: 0 },
    ]);
  });

  test("a second finish of a claim that went back to queued writes nothing", async () => {
    const { sessionId, claimed, retry } = await claimedRetry();
    expect(await judgments.finish(claimed, retry)).toBe(true);
    await db
      .delete(sessionAchievements)
      .where(eq(sessionAchievements.sessionId, sessionId));
    expect(await judgments.finish(claimed, retry)).toBe(false);
    expect(await achievementsOf(sessionId)).toEqual([]);
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "queued", attempts: 1 },
    ]);
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

  test("a checkpoint queues a judgment only when its out/ list differs from its parent's, path by path, in its own transaction", async () => {
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
    const fence = {
      attemptId,
      authRevision: 1,
      executionGeneration: 1,
      leaseEpoch: 1,
      sessionId,
    };
    const checkpoint = (revision: number) => ({
      revision,
      manifest_ref: `sessions/${sessionId}/checkpoints/${revision}/${attemptId}/manifest.json`,
      manifest_sha256: "a".repeat(64),
    });
    type Listed = Parameters<typeof checkpointOutputsDigest>[0] & {};
    const stored = (path: string, digit: string) => ({
      path,
      sha256: digit.repeat(64),
      bytes: 42,
      key: `sessions/${sessionId}/checkpoints/1/${attemptId}/outputs/${digit.repeat(64)}`,
    });
    const listed = (outputs: Listed) => ({
      outputs: checkpointOutputObjects(outputs),
      outputsDigest: checkpointOutputsDigest(outputs),
    });
    const commit = (revision: number, outputs: Listed) =>
      commitCheckpoint(db, {
        checkpoint: checkpoint(revision),
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
        ...listed(outputs),
      });
    const queued = async () => {
      const rows = await judgmentsOf(sessionId);
      await db
        .delete(achievementJudgments)
        .where(eq(achievementJudgments.sessionId, sessionId));
      return rows.map((row) => row.status);
    };
    const report = stored("out/report.md", "a");
    const steps: [string, Listed, string[]][] = [
      ["no files", [], []],
      ["a new file", [report], ["queued"]],
      ["the same file inherited", [report], []],
      ["a rename", [{ ...report, path: "out/final.md" }], ["queued"]],
      [
        "a copy of the same content to a new path",
        [{ ...report, path: "out/final.md" }, report],
        ["queued"],
      ],
      [
        "a file over the limits, with no object",
        [
          { ...report, path: "out/final.md" },
          report,
          { path: "out/big.bin", bytes: 9e9, omitted: "too_large" },
        ],
        ["queued"],
      ],
      [
        "the same list in another order",
        [
          { path: "out/big.bin", bytes: 9e9, omitted: "too_large" },
          report,
          { ...report, path: "out/final.md" },
        ],
        [],
      ],
      ["a removal", [report], ["queued"]],
    ];
    const seen: [string, string[]][] = [];
    for (const [revision, [label, outputs]] of steps.entries()) {
      expect(await commit(revision, outputs)).toEqual({
        outcome: "committed",
        revision,
      });
      seen.push([label, await queued()]);
    }
    expect(seen).toEqual(steps.map(([label, , expected]) => [label, expected]));

    await expect(
      db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") throw new Error(fenced.outcome);
        const advanced = await advanceCheckpointPointer(tx, {
          fence,
          session: fenced.session,
          checkpoint: checkpoint(steps.length),
          turnRowId: null,
          now: new Date(),
          versionsHeld: false,
          ...listed([stored("out/other.md", "c")]),
        });
        expect(advanced.outcome).toBe("committed");
        const inside = await tx
          .select({ id: achievementJudgments.id })
          .from(achievementJudgments)
          .where(eq(achievementJudgments.sessionId, sessionId));
        expect(inside).toHaveLength(1);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await queued()).toEqual([]);

    // A judgment that gave up on an unreadable out/ is retried by the next
    // checkpoint, though the list did not change.
    await db.insert(achievementJudgments).values({
      id: randomUUID(),
      workspaceId,
      ownerId: workspaceId,
      sessionId,
      trigger: "evidence",
      status: "failed",
      errorCode: "outputs_unavailable",
      nextAttemptAt: new Date(),
      finishedAt: new Date(),
    });
    expect(await commit(steps.length, [report])).toMatchObject({
      outcome: "committed",
    });
    expect(await queued()).toEqual(["failed", "queued"]);
    expect(await commit(steps.length + 1, [report])).toMatchObject({
      outcome: "committed",
    });
    expect(await queued()).toEqual([]);
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
      link: `/sessions/${sessionId}`,
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

  test("one out/ path counts once in its session and once in each other session", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const report = (sessionId: string) =>
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
    const a = await session(ws.workspaceId);
    const b = await session(ws.workspaceId);
    report(a);
    report(b);
    for (let trigger = 0; trigger < 2; trigger += 1) {
      for (const sessionId of [a, b]) {
        await queueAchievementJudgment(db, sessionId);
        await quietPassed(sessionId);
      }
      await replica().runOnce();
    }
    for (const sessionId of [a, b]) {
      expect(
        (await achievementsOf(sessionId)).map((row) => row.evidenceId),
      ).toEqual(["out/report.md"]);
    }
  });

  test("an unavailable out/ list still counts the pull request, then retries 1 minute later until the retries run out", async () => {
    const ws = await workspace();
    await rule(ws, await typeId(ws.workspaceId, "pull_request"));
    await rule(ws, await typeId(ws.workspaceId, "document"));
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
    outputsBySession.set(sessionId, {
      status: "unavailable",
      reason: "store down",
    });
    await quietPassed(sessionId);

    const before = Date.now();
    await replica().runOnce();
    const [retrying] = await judgmentsOf(sessionId);
    expect(retrying).toMatchObject({
      status: "queued",
      errorCode: "outputs_unavailable",
      attempts: 1,
    });
    expect(retrying?.finishedAt).toBeNull();
    const wait = (retrying?.nextAttemptAt.getTime() ?? 0) - before;
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThan(70_000);
    expect(
      (await achievementsOf(sessionId)).map((row) => row.evidenceId),
    ).toEqual([pr.id]);

    for (let retry = 0; retry < 3; retry += 1) {
      await quietPassed(sessionId);
      await replica().runOnce();
    }
    expect(await judgmentsOf(sessionId)).toMatchObject([
      { status: "failed", errorCode: "outputs_unavailable", attempts: 4 },
    ]);
    expect(await achievementsOf(sessionId)).toHaveLength(1);
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
    const counted = await rule(
      ws,
      await typeId(ws.workspaceId, "pull_request"),
    );
    const sessionId = await session(ws.workspaceId);
    const pr = await pullRequest(sessionId, ws.workspaceId);
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
      evidenceIds: [pr.id],
      achievements: [
        {
          ruleId: counted.id,
          ruleFamilyId: counted.family_id,
          typeId: counted.type_id,
          agentId: null,
          agentReleaseId: null,
          title: "late",
          link: pr.url,
          evidenceKind: "github_pull_request" as const,
          evidenceId: pr.id,
          payload: null,
          judge: "always" as const,
          reviewState: "auto" as const,
        },
      ],
    };
    expect(await judgments.finish(first, late)).toBe(false);
    expect(await achievementsOf(sessionId)).toEqual([]);
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

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  type ReceiptActor,
} from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresGitHubGateStore,
  createPostgresGitHubSettingsStore,
} from "./github-settings.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const GITHUB = {
  repositories: ["sample-app"],
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [{ workflow: "ci.yml" }],
  push_approval: false,
};

integration("GitHub gate and ceiling stores on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_gate_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userId],
    );
    return { workspaceId, userId };
  }

  /** An agent whose active release carries `pins`. */
  async function agent(workspaceId: string, pins: object, enabled = true) {
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, github_enabled) VALUES ($1, $2, $3, 'a', $4)",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`, enabled],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, repository_id, profile_digest,
         runtime_config_snapshot, effective_tools, policy_pins)
       VALUES ($1, $2, $3, $4, 'claude-coding-v1', 'sample-app', $5, '{}', '{}', $6)`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        `sha256:${"c".repeat(64)}`,
        JSON.stringify(pins),
      ],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    return { agentId, releaseId };
  }

  async function session(
    workspaceId: string,
    releaseId: string | null,
    createdBy: string | null,
  ) {
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id)
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
         $3, $4, $5)`,
      [sessionId, workspaceId, workspaceId, releaseId, createdBy],
    );
    return sessionId;
  }

  const ownerActor = (userId: string): ReceiptActor => ({
    principal: { kind: "user", id: userId },
    actor_user_id: userId,
    agent_id: null,
  });

  test("context reads the starter, the agent, the release's settings and the ceiling", async () => {
    const { workspaceId, userId } = await workspace();
    const { agentId, releaseId } = await agent(workspaceId, {
      github: GITHUB,
    });
    const sessionId = await session(workspaceId, releaseId, userId);
    const store = createPostgresGitHubGateStore(db);

    expect(await store.context(sessionId)).toEqual({
      ownerId: workspaceId,
      sessionId,
      repositoryId: "sample-app",
      repository: { url: "https://github.com/acme/app.git", branch: "main" },
      startedBy: userId,
      agent: { id: agentId, workspaceId, githubEnabled: true },
      release: { id: releaseId, github: GITHUB },
      ceiling: GITHUB_CEILING_NONE,
    });
    expect(await store.context(randomUUID())).toBeNull();

    const later = await agent(workspaceId, { github: { from: "later" } });
    const laterSession = await session(workspaceId, later.releaseId, null);
    expect((await store.context(laterSession))?.release?.github).toBe(
      "invalid",
    );
    expect((await store.context(laterSession))?.startedBy).toBeNull();
  });

  test("a dispatch keeps its receipt and run in one write, and a rerun finds it by repository and run", async () => {
    const { workspaceId, userId } = await workspace();
    const { agentId, releaseId } = await agent(workspaceId, {
      github: GITHUB,
    });
    const sessionId = await session(workspaceId, releaseId, userId);
    const store = createPostgresGitHubGateStore(db);
    const context = {
      ownerId: workspaceId,
      sessionId,
      agentId,
      agentReleaseId: releaseId,
      repositoryId: "sample-app",
    };
    const receiptId = await store.recordDispatch({
      context,
      actor: ownerActor(userId),
      result: { workflow: "ci.yml", ref: "main", input_keys: ["env"] },
      run: { id: 9_012_345_678, workflow: "ci.yml", ref: "main" },
    });

    expect(await store.findDispatch("sample-app", 9_012_345_678)).toEqual({
      runId: 9_012_345_678,
      repositoryId: "sample-app",
      workflow: "ci.yml",
      ref: "main",
    });
    expect(await store.findDispatch("other-app", 9_012_345_678)).toBeNull();
    const { rows } = await pool.query(
      "SELECT operation, status, result, target_ref FROM receipts WHERE id = $1",
      [receiptId],
    );
    expect(rows).toEqual([
      {
        operation: "dispatch_workflow",
        status: "succeeded",
        result: { workflow: "ci.yml", ref: "main", input_keys: ["env"] },
        target_ref: { session_id: sessionId, turn_id: null, request_id: null },
      },
    ]);

    // The same run twice is a programming error, not a second row.
    await expect(
      store.recordDispatch({
        context,
        actor: ownerActor(userId),
        result: {},
        run: { id: 9_012_345_678, workflow: "ci.yml", ref: "main" },
      }),
    ).rejects.toThrow();
    const counted = await pool.query(
      "SELECT count(*)::int AS n FROM receipts WHERE operation = 'dispatch_workflow' AND owner_id = $1",
      [workspaceId],
    );
    expect(counted.rows[0].n).toBe(1);
  });

  test("the ceiling is written under its revision with a receipt, and counts agents using each feature", async () => {
    const { workspaceId, userId } = await workspace();
    await agent(workspaceId, { github: GITHUB });
    await agent(workspaceId, { github: GITHUB }, false);
    await agent(workspaceId, {});
    const store = createPostgresGitHubSettingsStore(db);
    const ceiling: GitHubCeiling = { ...GITHUB_CEILING_NONE, actions: true };

    expect(await store.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
    });
    const put = (revision: number, next: GitHubCeiling) =>
      store.putCeiling({
        workspaceId,
        ceiling: next,
        revision,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    expect(await put(0, ceiling)).toEqual({
      outcome: "stored",
      settings: { ceiling, revision: 1 },
    });
    expect(await put(0, GITHUB_CEILING_NONE)).toEqual({
      outcome: "revision_conflict",
    });
    expect(await put(1, GITHUB_CEILING_NONE)).toMatchObject({
      outcome: "stored",
      settings: { revision: 2 },
    });
    expect(await store.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 2,
    });
    const { rows } = await pool.query(
      "SELECT result FROM receipts WHERE operation = 'set_github_ceiling' AND owner_id = $1 ORDER BY created_at",
      [workspaceId],
    );
    expect(rows.map((row) => row.result)).toEqual([
      { before: null, after: ceiling, revision: 1 },
      { before: ceiling, after: GITHUB_CEILING_NONE, revision: 2 },
    ]);
    // The switched-off agent and the one without settings do not count.
    expect(await store.agentsUsing(workspaceId)).toEqual({
      workflows: 0,
      actions: 1,
      checks: 0,
      issues: 0,
      review: 0,
    });
    expect(await store.appPermissions(workspaceId)).toEqual({
      author: null,
      reviewer: null,
    });
  });

  test("a ceiling put by someone demoted or disabled after the policy's check stores nothing", async () => {
    const { workspaceId, userId } = await workspace();
    const store = createPostgresGitHubSettingsStore(db);
    const put = () =>
      store.putCeiling({
        workspaceId,
        ceiling: { ...GITHUB_CEILING_NONE, actions: true },
        revision: 0,
        updatedBy: userId,
        actor: ownerActor(userId),
      });
    await pool.query(
      "UPDATE memberships SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    expect(await put()).toEqual({ outcome: "actor_inactive" });
    await pool.query(
      "UPDATE memberships SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    await pool.query("UPDATE users SET disabled_at = now() WHERE id = $1", [
      userId,
    ]);
    expect(await put()).toEqual({ outcome: "actor_inactive" });
    expect(await store.get(workspaceId)).toEqual({
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
    });
    const { rows } = await pool.query(
      "SELECT 1 FROM receipts WHERE operation = 'set_github_ceiling' AND owner_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([]);
  });

  test("a release with push_approval false creates the push request approved, by policy", async () => {
    const { workspaceId, userId } = await workspace();
    const { releaseId } = await agent(workspaceId, { github: GITHUB });
    const sessionId = await session(workspaceId, releaseId, userId);
    await pool.query(
      "UPDATE sessions SET checkpoint_revision = 1 WHERE id = $1",
      [sessionId],
    );
    const pushes = createPostgresPushRequests(db);

    const found = await pushes.findSession(workspaceId, sessionId);
    expect(found).toEqual({
      repositoryId: "sample-app",
      approvalOffRelease: releaseId,
    });
    const created = await pushes.create({
      ownerId: workspaceId,
      sessionId,
      actor: ownerActor(userId),
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      approvedByRelease: releaseId,
    });
    if (created.outcome !== "written") throw new Error("not written");
    expect(created.request).toMatchObject({ state: "approved" });
    const { rows } = await pool.query(
      "SELECT actor, status FROM receipts WHERE operation = 'decide_push' AND owner_id = $1",
      [workspaceId],
    );
    expect(rows).toEqual([{ actor: null, status: "succeeded" }]);

    const plain = await agent(workspaceId, {});
    const other = await session(workspaceId, plain.releaseId, userId);
    expect(await pushes.findSession(workspaceId, other)).toEqual({
      repositoryId: "sample-app",
      approvalOffRelease: null,
    });
  });
});

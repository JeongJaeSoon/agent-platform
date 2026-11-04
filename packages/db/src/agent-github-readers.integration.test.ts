import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  GITHUB_CEILING_NONE,
  GITHUB_POLICY_CLOSED,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { PushRequestStore, RunnablePair } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  agentGitHubSettingsOf,
  createPostgresGitHubGateStore,
  createPostgresGitHubSettingsStore,
  workspaceRepositoryCeiling,
} from "./github-settings.ts";
import { createPostgresGitHubMcpStore } from "./mcp-egress.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import { runnableCondition, runnablePairOf } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};
const COMMIT = "b".repeat(40);
const PIN_OFF = {
  repositories: ["sample-app"],
  push_approval: false,
  features: { ...GITHUB_CEILING_NONE },
  actions_allow: [],
};

integration("the readers of an agent's GitHub settings", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let pushes: PushRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_github_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    pushes = createPostgresPushRequests(db);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  /** A workspace, its agent and a session of the agent's active release. */
  async function fixture(
    options: { source?: "release" | "agent"; pins?: object } = {},
  ) {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    const sessionId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, github_enabled) VALUES ($1, $2, $3, 'a', true)",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`],
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
        JSON.stringify({ github: PIN_OFF, ...options.pins }),
      ],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, agent_release_id, created_by_user_id,
         github_policy_source, checkpoint_revision)
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
         $2, $3, $4, $5, 1)`,
      [sessionId, workspaceId, releaseId, userId, options.source ?? "release"],
    );
    return { workspaceId, agentId, releaseId, sessionId };
  }

  async function settingsRow(
    workspaceId: string,
    agentId: string,
    row: {
      repositories?: unknown[];
      pushApproval?: boolean;
      features?: object;
      revision?: number;
    },
  ) {
    await pool.query(
      `INSERT INTO agent_github_settings (agent_id, workspace_id, repositories,
         push_approval, features, actions_allow, revision)
       VALUES ($1, $2, $3, $4, $5, '[]', $6)
       ON CONFLICT (agent_id) DO UPDATE SET
         repositories = EXCLUDED.repositories,
         push_approval = EXCLUDED.push_approval,
         features = EXCLUDED.features,
         revision = EXCLUDED.revision`,
      [
        agentId,
        workspaceId,
        JSON.stringify(row.repositories ?? ["sample-app"]),
        row.pushApproval ?? true,
        JSON.stringify(row.features ?? GITHUB_CEILING_NONE),
        row.revision ?? 1,
      ],
    );
  }

  const request = (input: {
    workspaceId: string;
    sessionId: string;
    policyApproval: Awaited<
      ReturnType<PushRequestStore["findSession"]>
    > extends infer Found
      ? Found extends { policyApproval: infer Approval }
        ? Approval
        : never
      : never;
    policyFields?: object;
  }) =>
    pushes.create({
      ownerId: input.workspaceId,
      sessionId: input.sessionId,
      actor: ACTOR,
      idempotencyKey: `k-${randomUUID()}`,
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: COMMIT,
      policyApproval: input.policyApproval,
      policyFields: input.policyFields ?? {},
    });

  async function claimed(): Promise<string[]> {
    const sessionIds: string[] = [];
    for (;;) {
      const job = await pushes.claimNextApproved(60_000);
      if (job === null) return sessionIds;
      sessionIds.push(job.sessionId);
    }
  }

  const stateOf = async (id: string) => {
    const { rows } = await pool.query<{
      state: string;
      approval_basis: string | null;
      approval_settings_revision: number | null;
    }>(
      "SELECT state, approval_basis, approval_settings_revision FROM push_requests WHERE id = $1",
      [id],
    );
    return rows[0];
  };

  test("the gate reads a row on an `agent` session, and the pin on a `release` one", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    const gate = createPostgresGitHubGateStore(db);
    expect((await gate.context(sessionId))?.policy).toEqual({
      source: "agent",
      settings: GITHUB_POLICY_CLOSED,
      startRepositoryId: null,
      agentSettingsRevision: null,
    });
    await settingsRow(workspaceId, agentId, {
      repositories: ["sample-app", "docs"],
      revision: 4,
    });
    expect((await gate.context(sessionId))?.policy).toMatchObject({
      source: "agent",
      settings: { repositories: ["sample-app", "docs"] },
      agentSettingsRevision: 4,
    });
    await settingsRow(workspaceId, agentId, { repositories: [1], revision: 5 });
    expect((await gate.context(sessionId))?.policy).toMatchObject({
      source: "agent",
      settings: "invalid",
      agentSettingsRevision: 5,
    });

    const release = await fixture();
    await settingsRow(release.workspaceId, release.agentId, {
      repositories: ["docs"],
    });
    expect((await gate.context(release.sessionId))?.policy).toEqual({
      source: "release",
      settings: PIN_OFF,
      startRepositoryId: null,
      agentSettingsRevision: null,
    });
  });

  test("the workspace's repository ceiling and the row reach session start", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    expect(await workspaceRepositoryCeiling(db, workspaceId)).toBeNull();
    expect(await agentGitHubSettingsOf(db, agentId)).toBeNull();
    await settingsRow(workspaceId, agentId, { revision: 2 });
    expect(await agentGitHubSettingsOf(db, agentId)).toMatchObject({
      repositories: ["sample-app"],
      revision: 2,
    });
    const ceiling = {
      repository_ids: ["sample-app"],
      github_app_repositories: "listed" as const,
    };
    await pool.query(
      "INSERT INTO github_workspace_settings (workspace_id, repository_ceiling, revision) VALUES ($1, $2, 3)",
      [workspaceId, JSON.stringify(ceiling)],
    );
    expect(await workspaceRepositoryCeiling(db, workspaceId)).toEqual(ceiling);
    expect(
      await createPostgresGitHubGateStore(db).context(sessionId),
    ).toMatchObject({ repositoryCeiling: ceiling, ceilingRevision: 3 });
  });

  test("the feature count reads each agent's policy; a row that cannot be read counts for nothing", async () => {
    const features = { ...GITHUB_CEILING_NONE, review: true };
    const { workspaceId, agentId } = await fixture({
      pins: { github: { ...PIN_OFF, features } },
    });
    const store = createPostgresGitHubSettingsStore(db);
    expect((await store.agentsUsing(workspaceId)).review).toBe(1);
    await settingsRow(workspaceId, agentId, { features });
    expect((await store.agentsUsing(workspaceId)).review).toBe(1);
    await settingsRow(workspaceId, agentId, {
      features: GITHUB_CEILING_NONE,
    });
    expect((await store.agentsUsing(workspaceId)).review).toBe(0);
    await settingsRow(workspaceId, agentId, {
      repositories: [1],
      features,
    });
    expect((await store.agentsUsing(workspaceId)).review).toBe(0);
  });

  test("the built-in server's state carries the source; a bad row reads as none", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    const mcp = createPostgresGitHubMcpStore(db);
    await settingsRow(workspaceId, agentId, {});
    expect(await mcp.sessionState(sessionId)).toMatchObject({
      source: "agent",
      github: { repositories: ["sample-app"] },
    });
    await settingsRow(workspaceId, agentId, { repositories: [1] });
    expect(await mcp.sessionState(sessionId)).toMatchObject({
      source: "agent",
      github: null,
    });
    const release = await fixture();
    expect(await mcp.sessionState(release.sessionId)).toMatchObject({
      source: "release",
      github: PIN_OFF,
    });
  });

  test("a push the agent's row approved goes back to a person when the row turns approval on before the claim", async () => {
    const { workspaceId, agentId, sessionId } = await fixture({
      source: "agent",
    });
    await settingsRow(workspaceId, agentId, {
      pushApproval: false,
      revision: 2,
    });
    const found = await pushes.findSession(workspaceId, sessionId);
    expect(found?.policyApproval).toMatchObject({
      source: "agent",
      settingsRevision: 2,
    });
    const created = await request({
      workspaceId,
      sessionId,
      policyApproval: found?.policyApproval ?? null,
      policyFields: found?.policyFields ?? {},
    });
    if (created.outcome !== "written") throw new Error("not written");
    expect(await stateOf(created.request.id)).toEqual({
      state: "approved",
      approval_basis: "policy",
      approval_settings_revision: 2,
    });

    await settingsRow(workspaceId, agentId, {
      pushApproval: true,
      revision: 3,
    });
    expect(await claimed()).not.toContain(sessionId);
    expect(await stateOf(created.request.id)).toEqual({
      state: "requested",
      approval_basis: null,
      approval_settings_revision: null,
    });
    const { rows } = await pool.query<{ result: Record<string, unknown> }>(
      `SELECT result FROM receipts
        WHERE owner_id = $1 AND operation = 'resolve_push'
        ORDER BY created_at DESC LIMIT 1`,
      [workspaceId],
    );
    expect(rows[0]?.result).toMatchObject({
      refusal: "approval_required",
      policy_source: "agent",
      agent_settings_revision: 2,
    });
  });

  test("the row still off, the push is claimed; a person's approval outlives the row", async () => {
    const off = await fixture({ source: "agent" });
    await settingsRow(off.workspaceId, off.agentId, { pushApproval: false });
    const found = await pushes.findSession(off.workspaceId, off.sessionId);
    await request({
      workspaceId: off.workspaceId,
      sessionId: off.sessionId,
      policyApproval: found?.policyApproval ?? null,
    });

    const person = await fixture({ source: "agent" });
    await settingsRow(person.workspaceId, person.agentId, {
      pushApproval: true,
    });
    const asked = await request({
      workspaceId: person.workspaceId,
      sessionId: person.sessionId,
      policyApproval: null,
    });
    if (asked.outcome !== "written") throw new Error("not written");
    await pushes.decide({
      ownerId: person.workspaceId,
      sessionId: person.sessionId,
      pushRequestId: asked.request.id,
      actor: ACTOR,
      decision: "approve",
      gitCommit: COMMIT,
      reason: null,
      idempotencyKey: "k-decide",
      payloadHash: "h-decide",
    });
    expect(await stateOf(asked.request.id)).toMatchObject({
      state: "approved",
      approval_basis: "human",
    });
    await settingsRow(person.workspaceId, person.agentId, {
      pushApproval: false,
      revision: 2,
    });

    const sessionIds = await claimed();
    expect(sessionIds).toContain(off.sessionId);
    expect(sessionIds).toContain(person.sessionId);
  });

  test("a `release` session's approval stands whatever a row says later", async () => {
    const { workspaceId, agentId, sessionId } = await fixture();
    const found = await pushes.findSession(workspaceId, sessionId);
    expect(found?.policyApproval).toMatchObject({
      source: "release",
      settingsRevision: null,
    });
    await request({
      workspaceId,
      sessionId,
      policyApproval: found?.policyApproval ?? null,
    });
    await settingsRow(workspaceId, agentId, { pushApproval: true });
    expect(await claimed()).toContain(sessionId);
  });

  test("a pin that cannot be read keeps a person deciding", async () => {
    const { workspaceId, sessionId } = await fixture({
      pins: { github: { push_approval: false, from: "later" } },
    });
    expect(
      (await pushes.findSession(workspaceId, sessionId))?.policyApproval,
    ).toBeNull();
  });

  describe("a claim's SQL and the check after it", () => {
    const F1 = `sha256:${"1".repeat(64)}`;
    const F2 = `sha256:${"2".repeat(64)}`;
    const APP = {
      repositoryId: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    };
    const policy = (
      overrides: Partial<Extract<RunnablePair, { policy: true }>> = {},
    ): RunnablePair => ({
      policy: true,
      profileId: "p",
      profileFingerprint: F1,
      model: null,
      workspaceScoped: false,
      repositories: [APP],
      ...overrides,
    });
    const LISTS: Array<{
      name: string;
      pairs: RunnablePair[];
      release: boolean;
    }> = [
      { name: "any model", pairs: [policy()], release: false },
      {
        name: "one model",
        pairs: [policy({ model: "m1" })],
        release: false,
      },
      {
        name: "a workspace profile",
        pairs: [policy({ workspaceScoped: true })],
        release: true,
      },
      {
        name: "no repositories",
        pairs: [policy({ repositories: [] })],
        release: false,
      },
      {
        name: "beside the ordinary pairs",
        pairs: [
          policy(),
          {
            profileId: "p",
            profileFingerprint: F2,
            model: "m2",
            ...APP,
          },
          {
            profileId: "q",
            profileFingerprint: F1,
            model: null,
            repositoryId: null,
          },
        ],
        release: true,
      },
      {
        name: "two profiles, one scoped",
        pairs: [policy(), policy({ profileId: "q", workspaceScoped: true })],
        release: true,
      },
    ];
    const owner = `owner-${randomUUID()}`;

    beforeAll(async () => {
      const locations = [
        { repositoryMode: "none" as const },
        { repositoryMode: "repository" as const, ...APP, repoUrl: APP.url },
        {
          repositoryMode: "repository" as const,
          ...APP,
          repoUrl: "https://moved.invalid/app.git",
        },
        {
          repositoryMode: "repository" as const,
          ...APP,
          repositoryId: "other",
          repoUrl: APP.url,
        },
      ];
      const rows = [];
      for (const githubPolicySource of ["release", "agent"]) {
        for (const location of locations) {
          for (const profileFingerprint of [null, F1, F2]) {
            for (const model of [null, "m1", "m2"]) {
              for (const profileId of ["p", "q"]) {
                const { repositoryMode } = location;
                rows.push({
                  id: randomUUID(),
                  ownerId: owner,
                  githubPolicySource,
                  profileFingerprint,
                  model,
                  profileId,
                  repositoryMode,
                  repositoryId:
                    "repositoryId" in location ? location.repositoryId : null,
                  repoUrl: "repoUrl" in location ? location.repoUrl : null,
                  branch: "branch" in location ? location.branch : null,
                });
              }
            }
          }
        }
      }
      await db.insert(sessions).values(rows);
    });

    test.each(LISTS)("$name", async ({ pairs, release }) => {
      const all = await db
        .select()
        .from(sessions)
        .where(eq(sessions.ownerId, owner));
      const bySql = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.ownerId, owner), runnableCondition(pairs)));
      const byCheck = all.filter(
        (session) => runnablePairOf(session, pairs) !== undefined,
      );
      expect(bySql.map(({ id }) => id).sort()).toEqual(
        byCheck.map(({ id }) => id).sort(),
      );
      expect(byCheck.length).toBeGreaterThan(0);
      expect(
        byCheck.some((session) => session.githubPolicySource === "agent"),
      ).toBe(true);
      expect(
        byCheck.some((session) => session.githubPolicySource === "release"),
      ).toBe(release);
    });

    test("an `agent` session is not claimed on a repository the list does not hold", async () => {
      const off = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.ownerId, owner),
            eq(sessions.githubPolicySource, "agent"),
            eq(sessions.repositoryId, "other"),
            eq(sessions.profileId, "p"),
            eq(sessions.profileFingerprint, F1),
          ),
        );
      expect(off.length).toBeGreaterThan(0);
      for (const session of off) {
        expect(runnablePairOf(session, [policy()])).toBeUndefined();
      }
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type AgentAuthority,
  callerFor,
  createAuthorizationPolicy,
  createSlackAppService,
  createSlackConfigTokens,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
  SessionServiceError,
  SlackApiError,
  type SlackConfigTokenStore,
} from "@werft-ai/platform";
import { createFakeSlackConfigApi } from "@werft-ai/platform/testing/slack";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentReleases,
  agents,
  agentVersions,
  memberships,
  secretValues,
  slackApps,
  slackConfigTokens,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSlackAppStore, slackAppKind } from "./slack-apps.ts";
import { createPostgresSlackConfigTokenStore } from "./slack-config-tokens.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];
const BINDERS = MANAGEMENT_ROLES["binding.manage"] ?? [];
const ORIGIN = "https://console.example.ts.net";

integration("Slack apps and the config token on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_apps_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function workspace() {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme" });
    return id;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role} person`,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    const principal = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
    const audit: SecretAudit = {
      principal,
      receiptId: randomUUID(),
      roles: MANAGERS,
    };
    return { userId, principal, audit };
  }

  async function agent(workspaceId: string, released = true) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      slug: `a-${agentId.slice(0, 8)}`,
      name: "Release notes",
    });
    if (!released) return agentId;
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {
        role: "Writes the release notes",
        instructions: "i",
        model: "m",
        capabilities: { tools: [], mcp: null, forbidden: [] },
      },
      contentSha256: "0".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      runtimeProfileId: "coding",
      profileDigest: "digest",
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    await db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 1 })
      .where(eq(agents.id, agentId));
    return agentId;
  }

  const fakeSlack = () =>
    createFakeSlackConfigApi({
      appIdPrefix: `A${randomBytes(4).toString("hex").toUpperCase()}X`,
    });

  function slowSlack(delayMs: number) {
    const slack = fakeSlack();
    const rotate = slack.api.rotateConfigToken;
    slack.api.rotateConfigToken = async (refresh) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return rotate(refresh);
    };
    return slack;
  }

  async function registered(
    store: SlackConfigTokenStore,
    slack: ReturnType<typeof createFakeSlackConfigApi>,
  ) {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const tokens = createSlackConfigTokens({ store, api: slack.api });
    expect(
      await tokens.register(workspaceId, slack.issueRefresh(), owner.audit),
    ).toMatchObject({ outcome: "stored" });
    return { workspaceId, owner, tokens };
  }

  describe("config token", () => {
    test("two processes needing a rotation at once make one Slack call and keep one row", async () => {
      const slack = slowSlack(150);
      const { workspaceId } = await registered(
        createPostgresSlackConfigTokenStore(db, key),
        slack,
      );
      await createPostgresSlackConfigTokenStore(db, key).expireAccess(
        workspaceId,
        new Date(),
      );
      slack.state.calls.length = 0;
      const first = createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, key),
        api: slack.api,
      });
      const second = createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, key),
        api: slack.api,
      });
      const [a, b] = await Promise.all([
        first.accessToken(workspaceId),
        second.accessToken(workspaceId),
      ]);
      expect(a.token).toBe(b.token);
      expect(slack.state.calls).toEqual([{ method: "tooling.tokens.rotate" }]);
      expect(
        await db
          .select()
          .from(slackConfigTokens)
          .where(eq(slackConfigTokens.workspaceId, workspaceId)),
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: secretValues.id })
          .from(secretValues)
          .where(eq(secretValues.workspaceId, workspaceId)),
      ).toHaveLength(1);
    });

    test("no transaction holds the token row while Slack is asked", async () => {
      const slack = fakeSlack();
      const store = createPostgresSlackConfigTokenStore(db, key);
      const { workspaceId } = await registered(store, slack);
      await store.expireAccess(workspaceId, new Date());
      const rotate = slack.api.rotateConfigToken;
      const lockedDuringCall: string[] = [];
      slack.api.rotateConfigToken = async (refresh) => {
        // NOWAIT fails at once if any open transaction holds either row.
        for (const sql of [
          "SELECT 1 FROM slack_config_tokens WHERE workspace_id = $1 FOR UPDATE NOWAIT",
          "SELECT 1 FROM secret_values WHERE workspace_id = $1 FOR UPDATE NOWAIT",
        ]) {
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query(sql, [workspaceId]);
          } catch (error) {
            lockedDuringCall.push(String(error));
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        }
        return rotate(refresh);
      };
      await createSlackConfigTokens({ store, api: slack.api }).accessToken(
        workspaceId,
      );
      expect(lockedDuringCall).toEqual([]);
    });

    test("an answer that cannot be stored asks for a new paste and keeps no value", async () => {
      const slack = fakeSlack();
      const store = createPostgresSlackConfigTokenStore(db, key);
      const { workspaceId } = await registered(store, slack);
      await store.expireAccess(workspaceId, new Date());
      let attempts = 0;
      const failing: SlackConfigTokenStore = {
        ...store,
        complete: async () => {
          attempts += 1;
          throw new Error("connection reset");
        },
      };
      const error = await createSlackConfigTokens({
        store: failing,
        api: slack.api,
      })
        .accessToken(workspaceId)
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect(error).toMatchObject({
        code: "CONFIG_TOKEN_INVALID",
        details: { reason_code: "needs_reentry" },
      });
      expect(attempts).toBe(3);
      expect(await store.describe(workspaceId)).toEqual({
        state: "needs_reentry",
        secret: null,
        expiresAt: null,
        issuer: null,
      });
      expect(
        await db
          .select({ id: secretValues.id })
          .from(secretValues)
          .where(eq(secretValues.workspaceId, workspaceId)),
      ).toEqual([]);
    });

    test("a lease left by a process that died mid-rotation turns the slot needs_reentry", async () => {
      const slack = fakeSlack();
      const store = createPostgresSlackConfigTokenStore(db, key);
      const { workspaceId } = await registered(store, slack);
      const at = new Date();
      const later = (ms: number) => new Date(at.getTime() + ms);
      const due = later(13 * 3600_000);
      expect(
        await store.claim(workspaceId, {
          now: due,
          freshUntil: due,
          leaseUntil: new Date(due.getTime() + 30_000),
        }),
      ).toMatchObject({ outcome: "claimed" });
      const meanwhile = new Date(due.getTime() + 1_000);
      expect(
        await store.claim(workspaceId, {
          now: meanwhile,
          freshUntil: meanwhile,
          leaseUntil: new Date(meanwhile.getTime() + 30_000),
        }),
      ).toMatchObject({ outcome: "busy" });
      const after = new Date(due.getTime() + 31_000);
      expect(
        await store.claim(workspaceId, {
          now: after,
          freshUntil: after,
          leaseUntil: new Date(after.getTime() + 30_000),
        }),
      ).toEqual({ outcome: "needs_reentry" });
      expect(await store.describe(workspaceId)).toMatchObject({
        state: "needs_reentry",
        secret: null,
      });
    });

    test("a refused paste leaves the stored token as it was", async () => {
      const slack = fakeSlack();
      const store = createPostgresSlackConfigTokenStore(db, key);
      const { workspaceId, owner, tokens } = await registered(store, slack);
      const before = await store.describe(workspaceId);
      const error = await tokens
        .register(workspaceId, "not-a-token-slack-knows", {
          ...owner.audit,
          receiptId: randomUUID(),
        })
        .catch((caught) => caught);
      expect(error).toMatchObject({
        code: "CONFIG_TOKEN_INVALID",
        details: { reason_code: "rejected" },
      });
      expect(await store.describe(workspaceId)).toEqual(before);
      expect(before.state).toBe("active");
    });

    test("the stored row and receipts never hold either token", async () => {
      const slack = fakeSlack();
      const store = createPostgresSlackConfigTokenStore(db, key);
      const { workspaceId, tokens } = await registered(store, slack);
      const { token } = await tokens.accessToken(workspaceId);
      const dumped = await pool.query(
        `SELECT
           (SELECT json_agg(t)::text FROM slack_config_tokens t WHERE workspace_id = $1) AS meta,
           (SELECT json_agg(s)::text FROM secret_values s WHERE workspace_id = $1) AS secret,
           (SELECT json_agg(r)::text FROM receipts r WHERE owner_id = $1::text) AS receipts`,
        [workspaceId],
      );
      const text = JSON.stringify(dumped.rows[0]);
      expect(text).not.toContain(token);
      for (const refresh of slack.state.refreshTokens) {
        expect(text).not.toContain(refresh);
      }
    });
  });

  describe("agent apps", () => {
    const store = () => createPostgresSlackAppStore(db, key);
    const begin = (
      workspaceId: string,
      agentId: string,
      actor: Parameters<
        ReturnType<typeof createPostgresSlackAppStore>["beginAgentApp"]
      >[0]["actor"],
      options: { staleBefore?: Date; replaceUncertain?: boolean } = {},
    ) =>
      store().beginAgentApp({
        workspaceId,
        agentId,
        actor,
        redirectUrl: `${ORIGIN}/agents/${agentId}/slack/callback`,
        newId: randomUUID(),
        staleBefore: options.staleBefore ?? new Date(Date.now() - 60_000),
        replaceUncertain: options.replaceUncertain ?? false,
      });

    function service(slack = fakeSlack()) {
      const tokens = createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, key),
        api: slack.api,
      });
      const authority: AgentAuthority = {
        agentOf: async (_workspace, resource) =>
          resource.kind === "agent" ? resource.id : null,
        isAdmin: async () => false,
      };
      return {
        slack,
        tokens,
        apps: createSlackAppService({
          authorization: createAuthorizationPolicy({ agents: authority }),
          apps: store(),
          tokens,
          api: slack.api,
          consoleOrigin: ORIGIN,
        }),
      };
    }

    async function withToken(
      slack: ReturnType<typeof createFakeSlackConfigApi>,
    ) {
      const workspaceId = await workspace();
      const owner = await person(workspaceId, "owner");
      await createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, key),
        api: slack.api,
      }).register(workspaceId, slack.issueRefresh(), owner.audit);
      return { workspaceId, owner };
    }

    test("the row is written creating before Slack is asked, and a lost answer leaves it", async () => {
      const { slack, apps } = service();
      const { workspaceId } = await withToken(slack);
      const agentId = await agent(workspaceId);
      let rowsWhenAsked: unknown[] = [];
      slack.state.next.create = async () => {
        rowsWhenAsked = await db
          .select({ state: slackApps.state, appId: slackApps.appId })
          .from(slackApps)
          .where(eq(slackApps.agentId, agentId));
        throw new SlackApiError("apps.manifest.create", "timeout", false);
      };
      await expect(
        apps.createAgentAppAsOperator(workspaceId, agentId, {
          replace_uncertain: false,
        }),
      ).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
      expect(rowsWhenAsked).toEqual([{ state: "creating", appId: null }]);
      const retried = await apps
        .createAgentAppAsOperator(workspaceId, agentId, {
          replace_uncertain: false,
        })
        .catch((caught) => caught);
      expect(retried).toMatchObject({
        code: "SLACK_APP_CREATING",
        details: { uncertain: false },
      });
      expect(
        slack.state.calls.filter((c) => c.method === "apps.manifest.create"),
      ).toHaveLength(1);
    });

    test("an uncertain creation is replaced only when asked, leaving the old row abandoned", async () => {
      const workspaceId = await workspace();
      const agentId = await agent(workspaceId);
      const first = await begin(workspaceId, agentId, null);
      expect(first.outcome).toBe("begun");
      const future = new Date(Date.now() + 120_000);
      expect(
        await begin(workspaceId, agentId, null, { staleBefore: future }),
      ).toMatchObject({ outcome: "creating", uncertain: true });
      const replaced = await begin(workspaceId, agentId, null, {
        staleBefore: future,
        replaceUncertain: true,
      });
      expect(replaced.outcome).toBe("begun");
      const rows = await db
        .select({ id: slackApps.id, state: slackApps.state })
        .from(slackApps)
        .where(eq(slackApps.agentId, agentId));
      expect(rows.map((row) => row.state).sort()).toEqual([
        "abandoned",
        "creating",
      ]);
    });

    test("the same agent again returns the same Slack app, and its secrets are sealed under the app", async () => {
      const { slack, apps } = service();
      const { workspaceId } = await withToken(slack);
      const agentId = await agent(workspaceId);
      const created = await apps.createAgentAppAsOperator(
        workspaceId,
        agentId,
        {
          replace_uncertain: false,
        },
      );
      const again = await apps.createAgentAppAsOperator(workspaceId, agentId, {
        replace_uncertain: false,
      });
      expect(created.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.slack_app.app_id).toBe(created.slack_app.app_id);
      expect(created.slack_app).toMatchObject({
        state: "created",
        created_by_token_user: "U0ISSUER",
        secrets: {
          slack_signing_secret: { configured: true },
          slack_client_secret: { configured: true },
          slack_bot_token: { configured: false },
        },
      });
      const owners = await db
        .select({
          ownerRef: secretValues.ownerRef,
          purpose: secretValues.purpose,
        })
        .from(secretValues)
        .where(eq(secretValues.workspaceId, workspaceId));
      expect(owners.filter((row) => row.ownerRef !== "workspace")).toEqual(
        expect.arrayContaining([
          {
            ownerRef: `slack_app:${created.slack_app.id}`,
            purpose: "slack_signing_secret",
          },
          {
            ownerRef: `slack_app:${created.slack_app.id}`,
            purpose: "slack_client_secret",
          },
        ]),
      );
      expect(
        slack.state.calls.filter((c) => c.method === "apps.manifest.create"),
      ).toHaveLength(1);
    });

    test("two requests for one agent's app at once begin one creation", async () => {
      const workspaceId = await workspace();
      const agentId = await agent(workspaceId);
      const results = await Promise.all([
        begin(workspaceId, agentId, null),
        begin(workspaceId, agentId, null),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "begun",
        "creating",
      ]);
    });

    test("an agent with no active release, or another workspace's agent, gets no app", async () => {
      const workspaceId = await workspace();
      expect(
        await begin(workspaceId, await agent(workspaceId, false), null),
      ).toEqual({ outcome: "agent_not_active" });
      const other = await workspace();
      expect(await begin(workspaceId, await agent(other), null)).toEqual({
        outcome: "agent_not_found",
      });
      expect(await begin(workspaceId, "not-a-uuid", null)).toEqual({
        outcome: "agent_not_found",
      });
    });

    test("the actor's right is read again: a member is outranked, the agent's admin is not", async () => {
      const workspaceId = await workspace();
      const agentId = await agent(workspaceId);
      const member = await person(workspaceId, "member");
      expect(
        await begin(workspaceId, agentId, {
          principal: member.principal,
          managerRoles: BINDERS,
        }),
      ).toEqual({ outcome: "outranked" });
      await db
        .insert(agentAdmins)
        .values({ workspaceId, agentId, userId: member.userId });
      expect(
        await begin(workspaceId, agentId, {
          principal: member.principal,
          managerRoles: BINDERS,
        }),
      ).toMatchObject({ outcome: "begun" });
    });

    test("an app id is found only in its own workspace", async () => {
      const workspaceId = await workspace();
      const agentId = await agent(workspaceId);
      const begun = await begin(workspaceId, agentId, null);
      if (begun.outcome !== "begun") throw new Error(begun.outcome);
      const other = await workspace();
      expect(await store().find(other, begun.app.id)).toBeNull();
      expect(await slackAppKind(db, other, begun.app.id)).toBeNull();
      expect(await slackAppKind(db, workspaceId, begun.app.id)).toBe("agent");
      expect(await slackAppKind(db, workspaceId, "not-a-uuid")).toBeNull();
      expect(
        await store().beginDelete({
          workspaceId: other,
          slackAppId: begun.app.id,
          actor: null,
        }),
      ).toEqual({ outcome: "not_found" });
    });

    test("deleting drops the app's secrets and keeps the row as deleted", async () => {
      const { slack, apps } = service();
      const { workspaceId, owner } = await withToken(slack);
      const agentId = await agent(workspaceId);
      const created = await apps.createAgentAppAsOperator(
        workspaceId,
        agentId,
        {
          replace_uncertain: false,
        },
      );
      const deleted = await apps.deleteApp(
        owner.principal,
        workspaceId,
        created.slack_app.id,
      );
      expect(deleted.slack_app).toMatchObject({
        state: "deleted",
        secrets: {
          slack_signing_secret: { configured: false },
          slack_client_secret: { configured: false },
        },
      });
      expect(slack.state.apps.size).toBe(0);
      const [row] = await db
        .select()
        .from(slackApps)
        .where(eq(slackApps.id, created.slack_app.id));
      expect(row).toMatchObject({
        state: "deleted",
        signingSecretRef: null,
        clientSecretRef: null,
      });
    });

    const beginLink = (
      workspaceId: string,
      actor: Parameters<
        ReturnType<typeof store>["beginLinkApp"]
      >[0]["actor"] = null,
    ) =>
      store().beginLinkApp({
        workspaceId,
        actor,
        redirectUrl: `${ORIGIN}/settings/linked-accounts/slack`,
        newId: randomUUID(),
        staleBefore: new Date(Date.now() - 60_000),
        replaceUncertain: false,
      });

    test("two link app requests at once begin one creation, named after the workspace", async () => {
      const workspaceId = await workspace();
      const results = await Promise.all([
        beginLink(workspaceId),
        beginLink(workspaceId),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "begun",
        "creating",
      ]);
      const begun = results.find((result) => result.outcome === "begun");
      expect(begun).toMatchObject({
        workspaceName: "Acme",
        app: { kind: "link", agentId: null, state: "creating" },
      });
      expect(await beginLink(randomUUID())).toEqual({
        outcome: "workspace_not_found",
      });
    });

    test("an explicit link app request reads the actor's role again: a member is outranked", async () => {
      const workspaceId = await workspace();
      const member = await person(workspaceId, "member");
      expect(
        await beginLink(workspaceId, {
          principal: member.principal,
          managerRoles: MANAGERS,
        }),
      ).toEqual({ outcome: "outranked" });
      const admin = await person(workspaceId, "admin");
      expect(
        await beginLink(workspaceId, {
          principal: admin.principal,
          managerRoles: MANAGERS,
        }),
      ).toMatchObject({ outcome: "begun" });
    });

    test("the link app's client is opened only once it is created", async () => {
      const slack = fakeSlack();
      const { workspaceId } = await withToken(slack);
      const begun = await beginLink(workspaceId);
      if (begun.outcome !== "begun") throw new Error("not begun");
      expect(await store().linkAppClient(workspaceId)).toBeNull();
      const created = {
        appId: `${slack.state.userId}LINK`,
        clientId: "1000.9",
        clientSecret: randomBytes(16).toString("hex"),
        signingSecret: randomBytes(16).toString("hex"),
      };
      await store().finishCreate({
        workspaceId,
        slackAppId: begun.app.id,
        created,
        tokenUserId: "U0ISSUER",
      });
      expect(await store().linkAppClient(workspaceId)).toMatchObject({
        app: { id: begun.app.id, kind: "link", clientId: "1000.9" },
        clientSecret: created.clientSecret,
      });
      expect(await store().linkAppClient(await workspace())).toBeNull();
      expect(await slackAppKind(db, workspaceId, begun.app.id)).toBe("link");
    });
  });
});

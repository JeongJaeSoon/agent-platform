import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { agentCardSchema, SESSION_SCOPE_VALUES } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSlackInboundEventStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  type Database,
  memberships,
  registerSlackInstallation,
  slackApps,
  slackOutbox,
  users,
  verifySlackInstallation,
  workspaces,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  agentSlackBotToken,
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createSlackBotApi,
  createSlackChannelJoiner,
  createSlackWelcome,
  createSurfaceBindingService,
  deploymentWelcomeKey,
  drainSlackInbox,
  drainSlackOutbox,
  SecretKey,
  type SessionCatalogConfig,
  type SlackInstalled,
  slackBotToken,
  slackConversationKey,
  slackWelcomeText,
} from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { Pool } from "pg";
import {
  loadSessionCatalog,
  PROFILES_FILE,
  REPOSITORIES_FILE,
} from "../api/catalog-config.ts";
import { slackRoleStartup, slackSessionHandler } from "./main.ts";

// The API side (activation, binding writes, install Finalize) and the
// `slack` role (the invite event, the outbox) over one database and the
// fake Slack, wired as server.ts and main.ts wire them.

const PROFILES = `profiles:
  general:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    repository: none
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
`;
const APP_ID = "A0WELCOME";
const TEAM = "T0ACME";
const BOT_USER = "U0BOT";
const MANAGERS = ["owner", "admin"] as const;
const ENVIRONMENT = {
  EXECUTION_SLOT_LIMIT: "10",
  MAX_TURN_SECONDS: "3600",
  PROVIDER_MAX_RETRIES: "2",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
};
// Made here, at runtime: the fake only checks it is one it was given.
const BOT_CREDENTIAL = `bot-${randomBytes(12).toString("hex")}`;

const slack = startFakeSlackApi({ teamId: TEAM });
slack.apps.set(APP_ID, {
  appId: APP_ID,
  clientId: "1.1",
  clientSecret: randomBytes(8).toString("hex"),
  signingSecret: randomBytes(8).toString("hex"),
  manifest: {},
  botTokens: [BOT_CREDENTIAL],
});
const logger = createLogger({ level: "error", sinks: [] });
const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

let root = "";
let catalog: SessionCatalogConfig;
let db: Database;

afterAll(async () => {
  slack.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const ENGINES = testDatabaseUrl() ? ["PGlite", "PostgreSQL"] : ["PGlite"];

function useDatabase(engine: string) {
  let close = async () => {};
  beforeEach(async () => {
    if (!root) {
      root = await mkdtemp(join(tmpdir(), "slack-welcome-"));
      await writeFile(join(root, PROFILES_FILE), PROFILES);
      await writeFile(join(root, REPOSITORIES_FILE), "repositories: {}\n");
      catalog = (
        await slackRoleStartup(
          {
            DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
            PLATFORM_CONFIG_DIR: root,
          },
          async () => {
            throw new Error("no secret is read");
          },
        )
      ).catalog;
    }
    if (engine === "PGlite") {
      const client = new PGlite();
      const pglite = drizzle(client, { schema });
      await migrate(pglite, {
        migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
      });
      db = pglite as unknown as Database;
      close = () => client.close();
    } else {
      const database = await createTempDatabase({ prefix: "slack_welcome" });
      const pool = new Pool({ connectionString: database.url, max: 8 });
      db = drizzlePostgres(pool, { schema });
      close = async () => {
        await pool.end();
        await database.drop();
      };
    }
    slack.calls.length = 0;
    slack.messages.length = 0;
    slack.statuses.length = 0;
    slack.failures.clear();
  }, 60_000);
  afterEach(() => close());
}

const card = (instructions: string) =>
  agentCardSchema.parse({
    role: "r",
    instructions,
    model: "claude-sonnet-5",
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });

async function installedAgent() {
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `ws-${workspaceId.slice(0, 8)}`,
    name: "ws",
  });
  const ownerId = randomUUID();
  await db.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "owner",
  });
  await db
    .insert(memberships)
    .values({ workspaceId, userId: ownerId, role: "owner" });
  const owner: Caller = callerFor(
    {
      kind: "user",
      id: ownerId,
      workspace_id: workspaceId,
      role: "owner",
      scopes: [...SESSION_SCOPE_VALUES],
    },
    { kind: "web" },
    randomUUID(),
  );

  const authorization = createAuthorizationPolicy({
    identity: createDatabaseIdentityReader(db),
  });
  const agentStore = createPostgresAgentStore(db);
  const bindingStore = createPostgresSurfaceBindingStore(db);
  const appStore = createPostgresSlackAppStore(db, key);
  const slackBotApi = createSlackBotApi({ apiUrl: slack.url });
  const join = createSlackChannelJoiner({
    bindings: bindingStore,
    slack: slackBotApi,
    botToken: (workspace, agent) =>
      agentSlackBotToken(
        { apps: appStore, secrets: createPostgresSecretStore(db, key) },
        workspace,
        agent,
      ),
  });
  const welcome = createSlackWelcome({
    agents: agentStore,
    bindings: bindingStore,
    apps: appStore,
    outbox: createPostgresSlackOutboxStore(db),
    join,
    logger,
  });
  const agents = createAgentService({
    authorization,
    store: agentStore,
    catalog: await loadSessionCatalog({
      dir: root,
      env: { PROVIDER_KEY: "api-side-only" },
      readSecret: async () => undefined,
    }),
    credentials: createPostgresCredentialBindingStore(db),
    welcome,
  });
  const bindings = createSurfaceBindingService({
    authorization,
    store: bindingStore,
    channels: {
      kindOf: async (_workspace, _agent, channelId) =>
        slackBotApi.channelKind(BOT_CREDENTIAL, channelId),
    },
    join,
    welcome,
  });

  const created = await agents.createAgent(owner, {
    slug: "notes",
    name: "Notes",
    card: card("i"),
  });
  const agentId = created.agent.id;
  const slackAppId = randomUUID();
  await db.insert(slackApps).values({
    id: slackAppId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId: APP_ID,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
  });
  await appStore.storeBotToken({
    workspaceId,
    slackAppId,
    botToken: BOT_CREDENTIAL,
  });
  await registerSlackInstallation(db, {
    appId: APP_ID,
    teamId: TEAM,
    workspaceId,
  });
  await verifySlackInstallation(db, {
    appId: APP_ID,
    teamId: TEAM,
    botUserId: BOT_USER,
  });
  const linked = await createPostgresAgentIdentityStore(db).link({
    principal: owner,
    workspaceId,
    agentId,
    key: { appId: APP_ID, teamId: TEAM },
    credentialRef: "slack_bot_token",
    managerRoles: MANAGERS,
  });
  if (linked.outcome !== "linked") throw new Error(linked.outcome);

  let revision = -1;
  const release = async (instructions?: string) => {
    let versionId = created.versions[0]?.id ?? "";
    if (instructions !== undefined) {
      const updated = await agents.updateAgent(owner, agentId, {
        card: card(instructions),
      });
      versionId = updated.versions.at(-1)?.id ?? "";
    }
    return agents.createRelease(owner, agentId, {
      version_id: versionId,
      runtime_profile_id: "general",
    });
  };
  const activate = async (releaseId: string) => {
    const activated = await agents.activateAgent(owner, agentId, {
      release_id: releaseId,
      expected_revision: revision,
    });
    revision = activated.activation_revision;
    return activated;
  };
  const bind = (channelId: string, home: boolean) =>
    bindings.putSlackBinding(owner, agentId, {
      channel_id: channelId,
      mode: "mention",
      home,
    });
  const finalize = () =>
    welcome.finalize({ workspaceId, agentId } as SlackInstalled);
  const list = async () =>
    (await bindings.listSlackBindings(owner, agentId)).items;
  return {
    workspaceId,
    agentId,
    slackAppId,
    release,
    activate,
    bind,
    finalize,
    list,
  };
}

const outboxRows = () =>
  db.select().from(slackOutbox).orderBy(asc(slackOutbox.seq));
const callsOf = (method: string) =>
  slack.calls.filter((call) => call.method === method).length;

function outboxPass() {
  const secrets = createPostgresSecretStore(db, key);
  return drainSlackOutbox({
    outbox: createPostgresSlackOutboxStore(db),
    slack: createSlackBotApi({ apiUrl: slack.url }),
    botToken: (workspaceId, slackAppId) =>
      slackBotToken(secrets, workspaceId, slackAppId),
    logger,
    consoleOrigin: null,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

let eventCounter = 0;

async function invited(
  fixture: { workspaceId: string; agentId: string; slackAppId: string },
  channel: string,
) {
  const app = slack.conversations.find((candidate) => candidate.id === channel);
  app?.members.push(APP_ID);
  eventCounter += 1;
  const eventId = `EvJoin${eventCounter}`;
  const event = { type: "member_joined_channel", user: BOT_USER, channel };
  await createPostgresSlackInboundEventStore(db).record({
    workspaceId: fixture.workspaceId,
    agentId: fixture.agentId,
    slackAppId: fixture.slackAppId,
    teamId: TEAM,
    appId: APP_ID,
    eventId,
    eventType: "member_joined_channel",
    eventSubtype: null,
    eventTime: new Date(),
    status: "received",
    payload: { type: "event_callback", event_id: eventId, event },
    conversationKey: slackConversationKey(fixture.slackAppId, event),
  });
  return drainSlackInbox({
    inbox: createPostgresSlackInboundEventStore(db),
    handler: slackSessionHandler({
      db,
      pool: {
        connect: () => {
          throw new Error("no session control is asked of this role");
        },
      },
      environment: ENVIRONMENT,
      logger,
      catalog,
      secretKey: key,
      leaseMs: 30_000,
      slackApiUrl: slack.url,
    }),
    logger,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

async function settled(until: () => boolean) {
  for (let tick = 0; tick < 200 && !until(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe.each(ENGINES)("the deployment welcome on %s", (engine) => {
  useDatabase(engine);

  test("a public home is joined once, then each new release says so once in it", async () => {
    const [home] = slack.seedChannels([{ name: "home" }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();

    const bound = await fixture.bind(channel, true);
    expect(bound.slack_binding.membership).toEqual({
      state: "joined",
      error: null,
    });
    expect(callsOf("conversations.join")).toBe(1);
    // Saving it again finds the bot there.
    await fixture.bind(channel, true);
    expect(callsOf("conversations.join")).toBe(1);
    // No release is live yet: nothing to announce.
    expect(await outboxRows()).toEqual([]);

    const { release: first } = await fixture.release();
    await fixture.activate(first.id);
    expect(await outboxRows()).toHaveLength(1);

    // The same definition again is the same release, and it is live.
    const again = await fixture.release();
    expect(again.created).toBe(false);
    expect((await fixture.activate(first.id)).receipt_id).toBeNull();
    expect(await outboxRows()).toHaveLength(1);

    const { release: second } = await fixture.release("changed");
    await fixture.activate(second.id);
    // Back to the first: a rollback announces nothing.
    await fixture.activate(first.id);

    const rows = await outboxRows();
    expect(rows.map((row) => row.dedupeKey)).toEqual([
      deploymentWelcomeKey(fixture.agentId, first.id, bound.slack_binding.id),
      deploymentWelcomeKey(fixture.agentId, second.id, bound.slack_binding.id),
    ]);
    expect(rows[0]).toMatchObject({
      kind: "welcome",
      channelId: channel,
      threadTs: "",
      status: "pending",
    });

    expect(await outboxPass()).toMatchObject({ sent: 2 });
    expect(slack.messages).toEqual([
      expect.objectContaining({
        method: "chat.postMessage",
        channelId: channel,
        threadTs: null,
        text: slackWelcomeText("Notes"),
      }),
      expect.objectContaining({ threadTs: null }),
    ]);
    // No thread, so no thread status to clear.
    expect(slack.statuses).toEqual([]);
  });

  test("a private home waits for the invite: no row before it, one after, then duplicate", async () => {
    const [home] = slack.seedChannels([{ name: "secret", isPrivate: true }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    const { release } = await fixture.release();
    await fixture.activate(release.id);

    const bound = await fixture.bind(channel, true);
    expect(bound.slack_binding.membership).toEqual({
      state: "awaiting_invite",
      error: null,
    });
    expect(callsOf("conversations.join")).toBe(0);
    expect(await fixture.finalize()).toEqual({
      finalized: true,
      warnings: [{ code: "awaiting_invite", channel_id: channel }],
    });
    expect(await outboxRows()).toEqual([]);

    expect(await invited(fixture, channel)).toMatchObject({ processed: 1 });
    expect(await outboxRows()).toHaveLength(1);
    // Finalize again, and the same event again, find it sent already.
    expect(await fixture.finalize()).toEqual({
      finalized: true,
      warnings: [],
    });
    await invited(fixture, channel);
    expect(await outboxRows()).toHaveLength(1);
    expect(callsOf("conversations.join")).toBe(0);
  });

  test("a rollback before the invite stays silent after it", async () => {
    const [home] = slack.seedChannels([{ name: "secret", isPrivate: true }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    const bound = await fixture.bind(channel, true);
    const { release: first } = await fixture.release();
    const { release: second } = await fixture.release("changed");
    await fixture.activate(first.id);
    await fixture.activate(second.id);
    await fixture.activate(first.id);

    // The asks the activations left running may answer after the invite.
    expect(await invited(fixture, channel)).toMatchObject({ processed: 1 });
    await fixture.finalize();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await outboxRows()).toEqual([]);
    // Forward again to the newest: that one is announced.
    await fixture.activate(second.id);
    expect((await outboxRows()).map((row) => row.dedupeKey)).toEqual([
      deploymentWelcomeKey(fixture.agentId, second.id, bound.slack_binding.id),
    ]);
  });

  test("an activation never waits on Slack: an unchecked home is joined and welcomed after it returns", async () => {
    const [home] = slack.seedChannels([{ name: "later" }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    // The kind lookup goes through; the membership one is rate limited,
    // so membership stays unknown.
    slack.rateLimit("conversations.info", 1, 1, 1);
    const bound = await fixture.bind(channel, true);
    expect(bound.slack_binding.membership).toBeUndefined();
    expect(callsOf("conversations.join")).toBe(0);

    const { release } = await fixture.release();
    await fixture.activate(release.id);
    await settled(() => callsOf("conversations.join") > 0);
    // The enqueue follows the join.
    for (let tick = 0; tick < 200; tick += 1) {
      if ((await outboxRows()).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await outboxRows()).toHaveLength(1);
  });

  test("a join Slack refuses leaves its cause on the binding and fails nothing", async () => {
    const [archived] = slack.seedChannels([{ name: "old", isArchived: true }]);
    const [locked] = slack.seedChannels([{ name: "locked" }]);
    const fixture = await installedAgent();
    const { release } = await fixture.release();
    await fixture.activate(release.id);

    expect(
      (await fixture.bind(archived?.id ?? "", false)).slack_binding.membership,
    ).toEqual({ state: "join_failed", error: "is_archived" });
    slack.failures.set("conversations.join", "restricted_action");
    expect(
      (await fixture.bind(locked?.id ?? "", true)).slack_binding.membership,
    ).toEqual({ state: "join_failed", error: "restricted_action" });
    // Retrying once the policy allows it joins and welcomes, once.
    slack.failures.clear();
    expect(
      (await fixture.bind(locked?.id ?? "", true)).slack_binding.membership,
    ).toEqual({ state: "joined", error: null });
    await fixture.bind(locked?.id ?? "", true);
    expect(await outboxRows()).toHaveLength(1);
    // What the console lists is what was stored.
    expect(
      (await fixture.list()).map((binding) => [
        binding.external_surface_id,
        binding.membership,
      ]),
    ).toEqual([
      [locked?.id, { state: "joined", error: null }],
      [archived?.id, { state: "join_failed", error: "is_archived" }],
    ]);
  });
});

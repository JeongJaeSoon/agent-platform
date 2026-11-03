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
import {
  agentCardRequestSchema,
  DEFAULT_SURFACE_CEILING,
  SESSION_SCOPE_VALUES,
  SLACK_NOTICE_MESSAGES,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  attempts,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresInstallationProfileStore,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSlackInboundEventStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  type Database,
  events,
  linkedAccounts,
  memberships,
  pendingRequests,
  pushRequests,
  receipts,
  registerSlackInstallation,
  sessionLinks,
  sessions,
  slackApps,
  slackOutbox,
  turns,
  users,
  verifySlackInstallation,
  workspaces,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import { createLogger, type LogRecord } from "@werft-ai/observability";
import {
  type Caller,
  type CatalogProfileView,
  type Connections,
  callerFor,
  catalogImports,
  catalogRepositoryIds,
  createAgentService,
  createAuthorizationPolicy,
  createOutboxSlackNoticeSink,
  createSlackBotApi,
  drainSlackInbox,
  drainSlackOutbox,
  SecretKey,
  type SessionCatalogConfig,
  SLACK_OUTBOX_MESSAGES,
  SLACK_RETRY_AFTER_MAX_MS,
  SLACK_TEXT_MAX,
  SlackApiError,
  slackBotToken,
  slackConversationKey,
} from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import {
  CONNECTIONS_FILE,
  loadSessionCatalog,
  PROFILES_FILE,
  REPOSITORIES_FILE,
  readSeedProfiles,
} from "../api/catalog-config.ts";
import { eventNeutralizer } from "../api/neutral-fields.ts";
import { slackRoleStartup, slackSessionHandler } from "./main.ts";

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
const CONNECTIONS = `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    auth:
      kind: api_key
      value_env: PROVIDER_KEY
`;
const APP_ID = "A0OUTBOX";
const TEAM = "T0ACME";
const BOT_USER = "U0BOT";
const PERSON = "U0OWNER";
const STRANGER = "U0STRANGER";
const CHANNEL = "C0OPS";
const THREAD = "100.000100";
const CONSOLE = "https://console.example";
// Made here, at runtime: the fake only checks it is the one it handed out.
const BOT_CREDENTIAL = `bot-${randomBytes(12).toString("hex")}`;
const MANAGERS = ["owner", "admin"] as const;
const ENVIRONMENT = {
  EXECUTION_SLOT_LIMIT: "10",
  MAX_TURN_SECONDS: "3600",
  PROVIDER_MAX_RETRIES: "2",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
  SLACK_OIDC_REDIRECT_URI: `${CONSOLE}/auth/slack/callback`,
};

const slack = startFakeSlackApi({ teamId: TEAM });
slack.apps.set(APP_ID, {
  appId: APP_ID,
  clientId: "1.1",
  clientSecret: randomBytes(8).toString("hex"),
  signingSecret: randomBytes(8).toString("hex"),
  manifest: {},
  botTokens: [BOT_CREDENTIAL],
});
const logged: LogRecord[] = [];
const logger = createLogger({
  level: "debug",
  sinks: [{ write: (record) => void logged.push(record) }],
});
const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

let root = "";
let catalog: SessionCatalogConfig;
let connections: Connections;
let db: Database;

afterAll(async () => {
  slack.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

const ENGINES = testDatabaseUrl() ? ["PGlite", "PostgreSQL"] : ["PGlite"];

function useDatabase(engine: string) {
  let close = async () => {};
  beforeEach(async () => {
    await loadCatalog();
    if (engine === "PGlite") {
      const client = new PGlite();
      const pglite = drizzle(client, { schema });
      await migrate(pglite, {
        migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
      });
      db = pglite as unknown as Database;
      close = () => client.close();
    } else {
      const database = await createTempDatabase({ prefix: "slack_outbox" });
      const pool = new Pool({ connectionString: database.url, max: 8 });
      db = drizzlePostgres(pool, { schema });
      close = async () => {
        await pool.end();
        await database.drop();
      };
    }
    // The api role's startup import: the registry reads ceilings from rows.
    await createPostgresInstallationProfileStore(db).seedCatalog({
      entries: async () =>
        catalogImports(await readSeedProfiles(root, catalog)),
      repositoryIdsOf: catalogRepositoryIds(catalog.repositories),
    });
    slack.statuses.length = 0;
    slack.messages.length = 0;
    slack.failures.clear();
    slack.missingTs.clear();
    slack.users.clear();
    logged.length = 0;
  }, 60_000);
  afterEach(() => close());
}

async function loadCatalog() {
  if (root) return;
  root = await mkdtemp(join(tmpdir(), "slack-outbox-"));
  await writeFile(join(root, PROFILES_FILE), PROFILES);
  await writeFile(join(root, REPOSITORIES_FILE), "repositories: {}\n");
  await writeFile(join(root, CONNECTIONS_FILE), CONNECTIONS);
  const started = await slackRoleStartup(
    {
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
      PLATFORM_CONFIG_DIR: root,
    },
    async () => {
      throw new Error("no secret is read");
    },
  );
  catalog = started.catalog;
  connections = started.connections;
}

type Fixture = Awaited<ReturnType<typeof agentInSlack>>;

async function agentInSlack() {
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
  const agentsService = createAgentService({
    authorization: createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    }),
    store: createPostgresAgentStore(db),
    catalog: await loadSessionCatalog({
      dir: root,
      env: { PROVIDER_KEY: "api-side-only" },
      readSecret: async () => undefined,
    }),
    credentials: createPostgresCredentialBindingStore(db),
  });
  const created = await agentsService.createAgent(owner, {
    slug: "notes",
    name: "Notes",
    card: agentCardRequestSchema.parse({
      role: "r",
      instructions: "i",
      model: "claude-sonnet-5",
      capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
    }),
  });
  const agentId = created.agent.id;
  const { release } = await agentsService.createRelease(owner, agentId, {
    version_id: created.versions[0]?.id ?? "",
    runtime_profile_id: "general",
  });
  await agentsService.activateAgent(owner, agentId, {
    release_id: release.id,
    expected_revision: -1,
  });
  const slackAppId = randomUUID();
  await db.insert(slackApps).values({
    id: slackAppId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId: APP_ID,
    clientId: "1.1",
    redirectUrl: `${CONSOLE}/cb`,
  });
  await createPostgresSlackAppStore(db, key).storeBotToken({
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
  const bound = await createPostgresSurfaceBindingStore(db).set({
    principal: owner,
    workspaceId,
    agentId,
    channelId: CHANNEL,
    channelKind: "public_channel",
    mode: "on",
    home: false,
    ceiling: DEFAULT_SURFACE_CEILING,
    managerRoles: MANAGERS,
  });
  if (bound.outcome !== "set") throw new Error(bound.outcome);
  await db.insert(linkedAccounts).values({
    id: randomUUID(),
    workspaceId,
    userId: ownerId,
    provider: "slack",
    externalTenant: TEAM,
    externalUserId: PERSON,
    verifiedVia: "slack_oidc",
    verifiedAt: new Date(),
  });
  return { workspaceId, agentId, slackAppId };
}

let eventCounter = 0;

async function mention(fixture: Fixture, ts: string, user = PERSON) {
  eventCounter += 1;
  const eventId = `EvOut${eventCounter}`;
  const event = {
    type: "app_mention",
    channel: CHANNEL,
    user,
    ts,
    ...(ts === THREAD ? {} : { thread_ts: THREAD }),
    text: `<@${BOT_USER}> summarize the thread`,
  };
  await createPostgresSlackInboundEventStore(db).record({
    workspaceId: fixture.workspaceId,
    agentId: fixture.agentId,
    slackAppId: fixture.slackAppId,
    teamId: TEAM,
    appId: APP_ID,
    eventId,
    eventType: "app_mention",
    eventSubtype: null,
    eventTime: new Date(Date.now() + eventCounter),
    status: "received",
    payload: { type: "event_callback", event_id: eventId, event },
    conversationKey: slackConversationKey(fixture.slackAppId, event),
  });
  await drainSlackInbox({
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
      connections,
      secretKey: key,
      leaseMs: 30_000,
      notices: createOutboxSlackNoticeSink(createPostgresSlackOutboxStore(db)),
      slackApiUrl: slack.url,
    }),
    logger,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

async function sessionOf(fixture: Fixture) {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.workspaceId, fixture.workspaceId));
  if (!session) throw new Error("no session");
  return session.id;
}

const text = (value: string) => ({ text: value });
const toolUse = { tool_call: { id: "tu1", name: "Read", input: {} } };

/**
 * Ends turn `sequence` as the worker would, with these assistant events: one
 * stored event per block, with its engine-neutral fields.
 */
async function endTurn(
  sessionId: string,
  sequence: number,
  status: "completed" | "failed",
  said: Record<string, unknown>[][] = [],
) {
  const attemptId = `att-${randomUUID()}`;
  const [turn] = await db
    .update(turns)
    .set({ status, attemptId, endedAt: new Date() })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)))
    .returning({ id: turns.id });
  if (!turn) throw new Error("no turn");
  let sourceSequence = 0;
  for (const block of said.flat()) {
    sourceSequence += 1;
    await db.insert(events).values({
      sessionId,
      turnId: turn.id,
      attemptId,
      sourceSequence,
      type: "assistant",
      payload: { type: "assistant", parent_tool_use_id: null, ...block },
    });
  }
}

function outboxPass(
  overrides: Partial<Parameters<typeof drainSlackOutbox>[0]> = {},
) {
  const secrets = createPostgresSecretStore(db, key);
  return drainSlackOutbox({
    outbox: createPostgresSlackOutboxStore(db),
    slack: createSlackBotApi({ apiUrl: slack.url }),
    botToken: (workspaceId, slackAppId) =>
      slackBotToken(secrets, workspaceId, slackAppId),
    logger,
    consoleOrigin: CONSOLE,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
    ...overrides,
  });
}

// A copy of the session's first turn as turn `sequence`, still running.
async function addTurn(sessionId: string, sequence: number) {
  const { rows: columns } = (await db.execute(
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'turns'
          AND column_name NOT IN ('id', 'sequence', 'attempt_id', 'status', 'ended_at')
        ORDER BY ordinal_position`,
  )) as unknown as { rows: { column_name: string }[] };
  const copied = columns.map(({ column_name }) => `"${column_name}"`);
  await db.execute(
    sql.raw(`INSERT INTO turns (sequence, status, ${copied.join(", ")})
      SELECT ${sequence}, 'running', ${copied.map((column) => `t.${column}`).join(", ")}
      FROM turns t WHERE t.session_id = '${sessionId}' AND t.sequence = 1`),
  );
}

async function answeredThrough() {
  const [link] = await db
    .select({ answeredThrough: sessionLinks.answeredThrough })
    .from(sessionLinks);
  return link?.answeredThrough;
}

// Turn `sequence`, queued as asked from the web or the API: by the person
// who asked turn 1, or by no one.
async function askFrom(
  sessionId: string,
  sequence: number,
  channel: "web" | "api",
  message: string,
  byPerson: boolean,
) {
  await addTurn(sessionId, sequence);
  const [first] = await db
    .select({ actorId: turns.actorId })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
  await db
    .update(turns)
    .set({
      channel,
      message,
      status: "queued",
      actorId: byPerson ? (first?.actorId ?? null) : null,
    })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
}

const rows = () => db.select().from(slackOutbox).orderBy(asc(slackOutbox.seq));

const posted = () =>
  slack.messages.filter((message) => message.method === "chat.postMessage");

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Index Cond"?: string;
  Plans?: PlanNode[];
};

const reads = (node: PlanNode, relation: string): boolean =>
  node["Relation Name"] === relation ||
  (node.Plans ?? []).some((child) => reads(child, relation));

// The pass's own turns scan (alias `turns`; subplans use ot/st) either
// fetches by id, or is the inner side of a nested loop whose outer side has
// already read session_links and is bounded to that row's session by its
// index: probed once per live link, never per session or whole.
function turnsReadPerLink(plan: PlanNode, linkedOuter = false): boolean {
  if (plan["Relation Name"] === "turns" && plan.Alias === "turns") {
    const cond = plan["Index Cond"] ?? "";
    return (
      /\bid = ANY \(/.test(cond) ||
      (linkedOuter && /\bsession_id = /.test(cond))
    );
  }
  const children = plan.Plans ?? [];
  if (children.length === 0) return true;
  return children.every((child, index) =>
    turnsReadPerLink(
      child,
      linkedOuter ||
        (plan["Node Type"] === "Nested Loop" &&
          index > 0 &&
          reads(children[0] as PlanNode, "session_links")),
    ),
  );
}

describe("the outbox plan check", () => {
  const turnsBySession: PlanNode = {
    "Node Type": "Index Scan",
    "Relation Name": "turns",
    Alias: "turns",
    "Index Cond": "(session_id = sessions.id)",
  };
  const sessionsScan: PlanNode = {
    "Node Type": "Index Only Scan",
    "Relation Name": "sessions",
    Alias: "sessions",
  };
  const linksScan: PlanNode = {
    "Node Type": "Index Scan",
    "Relation Name": "session_links",
    Alias: "session_links",
  };

  test("accepts turns probed under the live links", () => {
    expect(
      turnsReadPerLink({
        "Node Type": "Nested Loop",
        Plans: [
          { "Node Type": "Nested Loop", Plans: [sessionsScan, linksScan] },
          turnsBySession,
        ],
      }),
    ).toBe(true);
  });

  test("refuses a whole turns index read under the links and filtered after", () => {
    expect(
      turnsReadPerLink({
        "Node Type": "Nested Loop",
        Plans: [
          linksScan,
          {
            "Node Type": "Materialize",
            Plans: [
              {
                "Node Type": "Index Scan",
                "Relation Name": "turns",
                Alias: "turns",
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  test("refuses turns read for every session before the links are checked", () => {
    expect(
      turnsReadPerLink({
        "Node Type": "Nested Loop",
        Plans: [
          { "Node Type": "Nested Loop", Plans: [sessionsScan, turnsBySession] },
          linksScan,
        ],
      }),
    ).toBe(false);
  });
});

describe.each(ENGINES)("the Slack outbox on %s", (engine) => {
  useDatabase(engine);

  test("a completed turn answers once in its thread, escaped, with its link, and clears the status", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [
      [text("Let me look."), toolUse],
      [
        text(
          "Done: ping <!here>, <@U0ELSE> and <@U0OWNER>, but `<!here>` stays code.",
        ),
      ],
    ]);

    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0, claimed: 0 });

    expect(posted()).toEqual([
      {
        method: "chat.postMessage",
        channelId: CHANNEL,
        threadTs: THREAD,
        userId: null,
        text: `Done: ping &lt;!here&gt;, &lt;@U0ELSE&gt; and <@${PERSON}>, but \`&lt;!here&gt;\` stays code.\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
        ts: expect.any(String),
        options: {
          link_names: "false",
          unfurl_links: "false",
          unfurl_media: "false",
        },
      },
    ]);
    const [row, ...others] = await rows();
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      kind: "reply",
      status: "sent",
      slackTs: posted()[0]?.ts,
      attempts: 1,
      claimToken: null,
      leaseExpiresAt: null,
    });
    expect(slack.statuses.at(-1)).toEqual({
      channelId: CHANNEL,
      threadTs: THREAD,
      status: "active",
    });
  });

  test("a reply stored before the neutral fields still answers with its text", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [
      [{ message: { content: [{ type: "text", text: "From before." }] } }],
    ]);
    const [session] = await db
      .select({ profileId: sessions.profileId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const neutralize = eventNeutralizer(
      {
        profiles: {
          [session?.profileId ?? ""]: {
            runtime_kind: "claude_agent_sdk",
          } as CatalogProfileView,
        },
      },
      logger,
    );
    expect(
      await outboxPass({
        outbox: createPostgresSlackOutboxStore(db, { neutralize }),
      }),
    ).toMatchObject({ enqueued: 1, sent: 1 });
    expect(posted()[0]?.text).toStartWith("From before.");
  });

  test("a turn that ended while the role was down for days still answers once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("late")]]);
    await db
      .update(turns)
      .set({ endedAt: sql`now() - interval '3 days'` })
      .where(eq(turns.status, "completed"));
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0 });
    expect(posted()).toHaveLength(1);
  });

  test("turns that started at the same instant answer in their thread's order", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    // Turn 3 gets the lower id: id order is not the thread's order.
    await addTurn(sessionId, 3);
    await addTurn(sessionId, 2);
    for (const sequence of [1, 2, 3]) {
      await endTurn(sessionId, sequence, "completed", [
        [text(`answer ${sequence}`)],
      ]);
    }

    expect(await outboxPass()).toMatchObject({ enqueued: 3, sent: 3 });
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "answer 1",
      "answer 2",
      "answer 3",
    ]);
  });

  test("a turn still running holds the thread's mark, and answers once it ends", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    await addTurn(sessionId, 2);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0 });
    expect(await answeredThrough()).toBe(1);

    await addTurn(sessionId, 3);
    await endTurn(sessionId, 3, "completed", [[text("answer 3")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0 });
    expect(await answeredThrough()).toBe(1);

    await endTurn(sessionId, 2, "completed", [[text("answer 2")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await outboxPass();
    expect(await answeredThrough()).toBe(3);
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "answer 1",
      "answer 3",
      "answer 2",
    ]);
  });

  test("a turn the platform queued, with no channel or actor, answers in the thread too", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("pushing next turn")]]);
    // A push continuation or an approved push's follow-up turn.
    await addTurn(sessionId, 2);
    await db
      .update(turns)
      .set({ channel: null, actorId: null })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 2)));
    await endTurn(sessionId, 2, "completed", [[text("PR opened")]]);

    await outboxPass();
    await outboxPass();
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "pushing next turn",
      "PR opened",
    ]);
    expect(await answeredThrough()).toBe(2);
  });

  test("behind a turn holding the mark, answers past one pass's batch still go", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    // Turn 1 runs on; 2 to 14 end, more than a pass's batch of 10.
    for (let sequence = 2; sequence <= 14; sequence += 1) {
      await addTurn(sessionId, sequence);
      await endTurn(sessionId, sequence, "completed", [
        [text(`answer ${sequence}`)],
      ]);
    }
    for (let pass = 0; pass < 3; pass += 1) await outboxPass();
    expect(posted()).toHaveLength(13);
    expect(await answeredThrough()).toBe(0);
  });

  test("an unknown outcome later confirmed completed still answers", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await db
      .update(turns)
      .set({ status: "outcome_unknown", endedAt: new Date() })
      .where(eq(turns.sessionId, sessionId));
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await outboxPass();
    expect(await answeredThrough()).toBe(0);

    // An operator's confirm_completed.
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      SLACK_NOTICE_MESSAGES.ko.failed,
      "answer 1",
    ]);
  });

  test("cancelled, interrupted and pre-link turns move the mark past them", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    for (const sequence of [2, 3, 4, 5]) await addTurn(sessionId, sequence);
    for (const [sequence, status] of [
      [2, "cancelled"],
      [3, "interrupted"],
    ] as const) {
      await db
        .update(turns)
        .set({ status, endedAt: new Date() })
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        );
    }
    await endTurn(sessionId, 4, "completed", [[text("before the link")]]);
    await db
      .update(turns)
      .set({ createdAt: sql`now() - interval '1 day'` })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 4)));
    await endTurn(sessionId, 5, "completed", [[text("answer 5")]]);

    expect(await outboxPass()).toMatchObject({ sent: 2 });
    await outboxPass();
    expect(await answeredThrough()).toBe(5);
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "answer 1",
      "answer 5",
    ]);
  });

  // Known order gap, left for later: a reply waiting out a backoff does not
  // hold back the next reply in its thread.
  test("a reply in backoff lets the thread's next reply go first", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    slack.failures.set("chat.postMessage", "internal_error");
    expect(await outboxPass()).toMatchObject({ retried: 1 });
    slack.failures.clear();
    await addTurn(sessionId, 2);
    await endTurn(sessionId, 2, "completed", [[text("answer 2")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(
      posted()
        .filter((message) => message.ts !== undefined)
        .map((message) => message.text.split("\n")[0]),
    ).toEqual(["answer 2", "answer 1"]);
  });

  test("the pass reads only linked sessions' turns and untold uncertain rows by index", async () => {
    if (engine !== "PostgreSQL") return;
    const plans: string[] = [];
    const traced = drizzlePostgres(
      (db as unknown as { $client: Pool }).$client,
      {
        schema,
        logger: {
          logQuery: (query, params) => {
            plans.push(JSON.stringify({ query, params }));
          },
        },
      },
    ) as unknown as Database;
    const outbox = createPostgresSlackOutboxStore(traced);
    await outbox.unansweredTurns(10);
    await outbox.unpostedInstructions(10);
    await outbox.untoldUncertain(10);
    const explainAs = async (captured: string | undefined, format: string) => {
      const { query, params } = JSON.parse(captured ?? "{}");
      const client = await (
        db as unknown as { $client: Pool }
      ).$client.connect();
      try {
        // Tables this small would be read whole; ask which index it would use.
        await client.query("SET enable_seqscan = off");
        const { rows } = await client.query(
          `EXPLAIN (COSTS OFF, FORMAT ${format}) ${query}`,
          params,
        );
        return rows;
      } finally {
        client.release(true);
      }
    };
    const explain = async (captured: string | undefined) =>
      (await explainAs(captured, "TEXT"))
        .map((row) => row["QUERY PLAN"])
        .join("\n");
    // Answers, then instructions.
    for (const captured of plans.slice(0, 2)) {
      const turnsPlan = await explain(captured);
      // The open turns found per link are fetched by id, or by the link's
      // session with the ids as a filter: the turns row width alone tips the
      // planner between the two. Neither reads turns outside linked sessions.
      const [{ "QUERY PLAN": json }] = await explainAs(captured, "JSON");
      expect(turnsReadPerLink(json[0].Plan)).toBe(true);
      expect(turnsPlan).not.toMatch(
        /Seq Scan on turns|Index Scan using turns_pkey on turns\s+Filter/,
      );
      // Ranged on the link and its mark, not a walk of the whole index.
      expect(turnsPlan).toMatch(
        /turns_session_sequence_uniq[\s\S]*Index Cond: \(\(session_id = [^)]+\) AND \(sequence > /,
      );
    }
    expect(await explain(plans.at(-1))).toContain("slack_outbox_uncertain_idx");
  });

  test("a web instruction goes to the thread once, under its sender's name and image, before its answer", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    slack.users.set(PERSON, { image48: "https://avatars.example/owner.png" });

    await askFrom(sessionId, 2, "web", "Add a test, <!here>", true);
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0, claimed: 0 });
    await endTurn(sessionId, 2, "completed", [[text("Added.")]]);
    await outboxPass();

    const thread = posted().slice(1);
    expect(
      thread.map(({ threadTs, text, options }) => ({
        threadTs,
        text,
        username: options.username,
        icon_url: options.icon_url,
      })),
    ).toEqual([
      {
        threadTs: THREAD,
        text: "owner (웹 콘솔)\nAdd a test, &lt;!here&gt;",
        username: "owner (웹 콘솔)",
        icon_url: "https://avatars.example/owner.png",
      },
      {
        threadTs: THREAD,
        text: expect.stringMatching(/^Added\./),
        username: undefined,
        icon_url: undefined,
      },
    ]);
    // Turn 1 came from Slack: it is already in the thread.
    expect(
      (await rows()).map(({ kind, dedupeKey }) => [kind, dedupeKey]),
    ).toEqual([
      ["reply", expect.stringMatching(/^reply:.*:1$/)],
      ["instruction", expect.stringMatching(/^instruction:.*:2$/)],
      ["reply", expect.stringMatching(/^reply:.*:2$/)],
    ]);
  });

  test("an answer that ended before its instruction went still follows it; a key no person made shows as API", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();

    await askFrom(sessionId, 2, "api", "Run the checks", false);
    await endTurn(sessionId, 2, "completed", [[text("Checks pass.")]]);
    // The answer is enqueued once its instruction has gone.
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });

    expect(
      posted()
        .slice(1)
        .map(({ text, options }) => [text.split("\n")[0], options.username]),
    ).toEqual([
      ["API", "API"],
      [expect.stringMatching(/^Checks pass\./), undefined],
    ]);
  });

  test("an answer waits for its instruction when a pass's batch did not reach it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    await askFrom(sessionId, 2, "web", "Second", true);
    await askFrom(sessionId, 3, "web", "Third", true);
    await endTurn(sessionId, 3, "completed", [[text("Third done.")]]);

    for (let pass = 0; pass < 3; pass += 1) {
      await outboxPass({ batchSize: 1 });
    }

    const sent = await rows();
    expect(
      sent.map(({ dedupeKey, status }) => [
        dedupeKey.replace(/:.*:/, ":"),
        status,
      ]),
    ).toEqual([
      ["reply:1", "sent"],
      ["instruction:2", "sent"],
      ["instruction:3", "sent"],
      ["reply:3", "sent"],
    ]);
    expect(sent.map((row) => row.slackTs)).toEqual(
      posted().map(({ ts }) => ts),
    );
  });

  test("an answer waits while its instruction backs off", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    await askFrom(sessionId, 2, "web", "Second", true);
    await endTurn(sessionId, 2, "completed", [[text("Second done.")]]);

    slack.failures.set("chat.postMessage", "internal_error");
    await outboxPass();
    slack.failures.clear();
    expect((await rows()).map(({ kind, status }) => [kind, status])).toEqual([
      ["reply", "sent"],
      ["instruction", "pending"],
    ]);

    await db
      .update(slackOutbox)
      .set({ nextAttemptAt: new Date() })
      .where(eq(slackOutbox.kind, "instruction"));
    await outboxPass();
    await outboxPass();
    expect(
      posted()
        .slice(1)
        .map(({ text }) => text.split("\n")[0]),
    ).toEqual(["owner (웹 콘솔)", "Second done."]);
  });

  test("an app refused the sender's name posts the instruction once as itself", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    await fetch(`${slack.url.replace(/\/api$/, "")}/fake/answers`, {
      method: "POST",
      body: JSON.stringify({
        method: "chat.postMessage",
        status: 200,
        body: { ok: false, error: "missing_scope" },
      }),
    });

    await askFrom(sessionId, 2, "web", "Add a test", true);
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });

    const [, instruction, ...rest] = posted();
    expect(rest).toEqual([]);
    expect(instruction?.text).toBe("owner (웹 콘솔)\nAdd a test");
    expect(instruction?.options.username).toBeUndefined();
  });

  test("a long answer is cut to Slack's limit with its link kept whole", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [
      [text(`${"가".repeat(SLACK_TEXT_MAX)}<@U0ELSE>`)],
    ]);
    await outboxPass();
    const [message] = posted();
    expect(message?.text.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(message?.text).toEndWith(
      `…\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    );
  });

  test("a failed turn gets one failure notice with its link", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await outboxPass();
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.ko.failed}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect((await rows()).map((row) => row.kind)).toEqual(["failure_notice"]);
  });

  test("a thread reads in the language of whoever started the session", async () => {
    const fixture = await agentInSlack();
    // The fixture's one user, the person who mentions the agent.
    await db.update(users).set({ locale: "en" });
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await outboxPass();
    await askFrom(sessionId, 2, "web", "Try again", true);
    await outboxPass();
    await db.update(users).set({ locale: "ja" });
    await askFrom(sessionId, 3, "web", "Once more", true);
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `We couldn't process the request right now. Try again shortly\n\n<${CONSOLE}/sessions/${sessionId}|Open on the web>`,
      "owner (Web console)\nTry again",
      "owner (Webコンソール)\nOnce more",
    ]);
    expect(posted()[1]?.options.username).toBe("owner (Web console)");

    const [row] = await rows();
    expect(row?.body).toMatchObject({ locale: "en" });
  });

  test("a refusal's reader is the user their Slack account is linked to", async () => {
    const fixture = await agentInSlack();
    const outbox = createPostgresSlackOutboxStore(db);
    const reader = (slackUserId: string) =>
      outbox.readerLocale({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        slackUserId,
      });
    expect(await reader(PERSON)).toBeNull();
    await db.update(users).set({ locale: "ja" });
    expect(await reader(PERSON)).toBe("ja");
    expect(await reader(STRANGER)).toBeNull();
    await db.update(linkedAccounts).set({ status: "stale" });
    expect(await reader(PERSON)).toBe("ja");
    await db.update(linkedAccounts).set({
      status: "revoked",
      revokedAt: new Date(),
      revokedReason: "unlinked",
    });
    expect(await reader(PERSON)).toBeNull();
    expect(
      await outbox.readerLocale({
        workspaceId: randomUUID(),
        teamId: TEAM,
        slackUserId: PERSON,
      }),
    ).toBeNull();
  });

  test("a failure notice whose send outlived its lease still clears the status", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "failed");
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    expect(await outbox.beginSend(claim)).toBe(true);
    await db
      .update(slackOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` });
    slack.statuses.length = 0;

    expect(await outboxPass()).toMatchObject({ uncertain: 1, claimed: 0 });
    expect(posted()).toEqual([]);
    expect(slack.statuses).toEqual([
      { channelId: CHANNEL, threadTs: THREAD, status: "active" },
    ]);
  });

  test("a reply whose thread was muted or unlinked while it waited is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    await db.update(sessionLinks).set({ muted: true });

    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    await outboxPass();
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("each request a turn waits on gets its own card once, with the buttons that settle it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const attemptId = `att-${randomUUID()}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${attemptId}`,
      leaseEpoch: session.leaseEpoch,
      executionGeneration: session.executionGeneration,
      authRevision: session.authRevision,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [turn] = await db
      .update(turns)
      .set({ status: "needs_input", attemptId })
      .where(eq(turns.sessionId, sessionId))
      .returning({ id: turns.id });
    await outboxPass();
    expect(posted()).toEqual([]);

    const ask = (requestId: string, payload: Record<string, unknown>) =>
      db.insert(pendingRequests).values({
        requestId,
        sessionId,
        turnId: turn?.id ?? 0,
        attemptId,
        kind: payload.kind as string,
        payload,
        inputHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
      });
    await ask("toolu:1", {
      kind: "permission",
      tool: "Bash",
      input: { command: "echo <@U0ALL> <!here>" },
    });
    await outboxPass();
    await outboxPass();
    const actionsOf = (message: { options: Record<string, string> }) =>
      (
        JSON.parse(message.options.blocks ?? "[]") as {
          type: string;
          elements?: { action_id?: string; value?: string }[];
        }[]
      )
        .filter((block) => block.type === "actions")
        .flatMap((block) => block.elements ?? []);
    expect(posted()).toHaveLength(1);
    const [card] = posted();
    if (!card) throw new Error("no card");
    expect(actionsOf(card).map((button) => button.action_id)).toEqual([
      "permission.allow",
      "permission.deny",
    ]);
    expect(JSON.parse(actionsOf(card)[0]?.value ?? "{}")).toEqual({
      s: sessionId,
      r: "toolu:1",
    });
    expect(card.options.blocks).toContain("rich_text_preformatted");
    expect(card.text).not.toContain("<!here>");
    const cardOf = () =>
      createPostgresSlackOutboxStore(db).promptCard({
        sessionId,
        requestId: "toolu:1",
        channelId: card.channelId,
        slackTs: card.ts,
      });
    const open = await cardOf();
    expect(open).toMatchObject({
      locale: "ko",
      deciderSlackUserId: null,
      display: { kind: "permission", tool: "Bash", state: "open" },
    });
    expect(open?.linkUrl).toStartWith(CONSOLE);
    expect(card.text).toContain(open?.linkUrl ?? "missing");
    expect(
      await createPostgresSlackOutboxStore(db).promptCard({
        sessionId,
        requestId: "toolu:1",
        channelId: card.channelId,
        slackTs: "1.000000",
      }),
    ).toBeNull();
    expect((await rows()).map((row) => [row.kind, row.dedupeKey])).toEqual([
      [
        "input_notice",
        `prompt:${(await db.select().from(sessionLinks))[0]?.id}:toolu:1`,
      ],
    ]);
    // The turn is still going: its status line stays.
    expect(slack.statuses.map((status) => status.status)).not.toContain(
      "active",
    );

    await ask("toolu:2", {
      kind: "question",
      questions: [
        {
          question_id: "q1",
          prompt: "Which branch?",
          options: [
            { option_id: "main", label: "main" },
            { option_id: "dev", label: "dev" },
          ],
          multi_select: false,
          allow_free_text: false,
        },
      ],
    });
    await outboxPass();
    expect(posted()).toHaveLength(2);
    expect(
      actionsOf(posted()[1] ?? card).map((button) => button.action_id),
    ).toEqual(["question.option:0", "question.option:1"]);

    await ask("toolu:3", { kind: "permission", tool: "Read", input: null });
    await outboxPass({ botToken: null });
    await db
      .update(pendingRequests)
      .set({ resolvedAt: new Date() })
      .where(eq(pendingRequests.requestId, "toolu:3"));
    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    expect(posted()).toHaveLength(2);
    expect(
      (await rows()).map((row) => [
        row.dedupeKey.split(":").at(-1),
        row.errorCode,
      ]),
    ).toEqual([
      ["1", null],
      ["2", null],
      ["3", "not_addressed"],
    ]);
  });

  test("a push request waiting for its decision gets one card, and none once decided", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const push = async (state: string, branch = "") => {
      const receiptId = randomUUID();
      await db.insert(receipts).values({
        id: receiptId,
        ownerId: session.ownerId,
        operation: "request_push",
        targetRef: { kind: "session", id: sessionId },
      });
      const id = randomUUID();
      await db.insert(pushRequests).values({
        id,
        ownerId: session.ownerId,
        sessionId,
        repositoryId: "sandbox",
        checkpointRevision: 1,
        gitCommit: "a".repeat(40),
        targetBranch: `agent/${sessionId}${branch}`,
        state,
        requestedBy: {
          principal: { kind: "installation", id: "i" },
          actor_user_id: null,
          agent_id: null,
        },
        requestReceiptId: receiptId,
        ...(state === "requested"
          ? {}
          : {
              decidedAt: new Date(),
              decidedBy: { kind: "policy" },
              decisionReceiptId: receiptId,
            }),
      });
      return { id, receiptId };
    };
    const decide = (pushed: { id: string; receiptId: string }) =>
      db
        .update(pushRequests)
        .set({
          state: "rejected",
          decidedAt: new Date(),
          decidedBy: { kind: "policy" },
          decisionReceiptId: pushed.receiptId,
        })
        .where(eq(pushRequests.id, pushed.id));
    const waiting = await push("requested");
    await push("pushed");
    await outboxPass();
    await outboxPass();
    expect(posted()).toHaveLength(1);
    const blocks = JSON.parse(posted()[0]?.options.blocks ?? "[]") as {
      type: string;
      elements?: { action_id?: string; value?: string }[];
      text?: { text?: string };
    }[];
    const buttons = blocks.flatMap((block) =>
      block.type === "actions" ? (block.elements ?? []) : [],
    );
    expect(buttons.map((button) => button.action_id)).toEqual([
      "push.approve",
      "push.reject",
    ]);
    expect(JSON.parse(buttons[0]?.value ?? "{}")).toEqual({
      s: sessionId,
      r: waiting.id,
    });
    expect(JSON.stringify(blocks)).toContain(`agent/${sessionId}`);

    const later = await push("requested", "-later");
    await outboxPass({ botToken: null });
    await decide(later);
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    expect(posted()).toHaveLength(1);
  });

  test("a send Slack took but whose answer cannot be read is never resent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const live = createSlackBotApi({ apiUrl: slack.url });
    const garbled = {
      ...live,
      postMessage: async () => ({
        httpStatus: 200,
        retryAfterHeader: null,
        body: null,
      }),
    };
    expect(await outboxPass({ slack: garbled })).toMatchObject({
      uncertain: 2,
    });
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "unreadable_answer"],
      ["failure_notice", "uncertain", "unreadable_answer"],
    ]);
  });

  test("a refusal reaches only the person who typed, once per thread", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD, STRANGER);
    await mention(fixture, "100.000200", STRANGER);
    await outboxPass();
    await outboxPass();
    expect(slack.messages).toEqual([
      {
        method: "chat.postEphemeral",
        channelId: CHANNEL,
        threadTs: THREAD,
        userId: STRANGER,
        text: `${SLACK_NOTICE_MESSAGES.ko.connect}\n\n<${CONSOLE}/settings/linked-accounts|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
        ts: expect.any(String),
        options: { link_names: "false" },
      },
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({ kind: "notice", status: "sent" });
    // A refusal is no answer: the thread's status is the handler's to set.
    expect(slack.statuses).toEqual([]);
  });

  test("a 429 waits out a clamped Retry-After, then sends once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.rateLimit("chat.postMessage", 86_400);
    expect(await outboxPass()).toMatchObject({ retried: 1, sent: 0 });
    const [waiting] = await db
      .select({
        status: slackOutbox.status,
        errorCode: slackOutbox.errorCode,
        waitMs: sql<number>`extract(epoch from ${slackOutbox.nextAttemptAt} - now()) * 1000`,
      })
      .from(slackOutbox);
    expect(waiting).toMatchObject({
      status: "pending",
      errorCode: "ratelimited",
    });
    expect(Number(waiting?.waitMs)).toBeLessThanOrEqual(
      SLACK_RETRY_AFTER_MAX_MS,
    );
    expect(Number(waiting?.waitMs)).toBeGreaterThan(
      SLACK_RETRY_AFTER_MAX_MS - 60_000,
    );
    expect(await outboxPass()).toMatchObject({ claimed: 0 });

    await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("a 429 whose body breaks off mid-read still waits out its Retry-After", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const brokenBody = () =>
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      });
    const limited = createSlackBotApi({
      apiUrl: slack.url,
      fetch: (async () =>
        new Response(brokenBody(), {
          status: 429,
          headers: { "retry-after": "3" },
        })) as unknown as typeof fetch,
    });
    expect(await outboxPass({ slack: limited })).toMatchObject({
      retried: 1,
      uncertain: 0,
    });
    expect((await rows())[0]).toMatchObject({
      status: "pending",
      errorCode: "ratelimited",
    });

    await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted()).toHaveLength(1);
  });

  test("a 5xx whose body breaks off mid-read is uncertain, never resent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const live = createSlackBotApi({ apiUrl: slack.url });
    const broken = createSlackBotApi({
      apiUrl: slack.url,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 503 },
        )) as unknown as typeof fetch,
    });
    const slackApi = { ...live, postMessage: broken.postMessage };
    expect(await outboxPass({ slack: slackApi })).toMatchObject({
      uncertain: 2,
      retried: 0,
    });
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "unreadable_answer"],
      ["failure_notice", "uncertain", "unreadable_answer"],
    ]);
  });

  test("ok without a ts fails and is never sent again", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.missingTs.add("chat.postMessage");
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    await outboxPass();
    expect(posted()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "missing_ts",
    });
  });

  test("a transient error backs off and fails on the fifth attempt", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.failures.set("chat.postMessage", "internal_error");
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await outboxPass();
      const [row] = await db
        .select({
          status: slackOutbox.status,
          attempts: slackOutbox.attempts,
          waitMs: sql<number>`extract(epoch from ${slackOutbox.nextAttemptAt} - now()) * 1000`,
        })
        .from(slackOutbox);
      expect(row?.attempts).toBe(attempt);
      expect(row?.status).toBe(attempt < 5 ? "pending" : "failed");
      if (attempt < 5) waits.push(Math.round(Number(row?.waitMs) / 1000));
      await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    }
    expect(waits).toEqual([30, 60, 120, 240]);
    expect((await rows())[0]).toMatchObject({ errorCode: "internal_error" });
    expect(slack.statuses.at(-1)).toMatchObject({ status: "active" });
  });

  test("an error no retry clears fails the row at once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.failures.set("chat.postMessage", "not_in_channel");
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_in_channel",
      attempts: 1,
    });
  });

  test("a send that outlived its lease is uncertain, never resent, and the thread hears so", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    expect(await outbox.beginSend(claim)).toBe(true);
    // The pass died mid-send.
    await db
      .update(slackOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` });

    expect(await outboxPass()).toMatchObject({ uncertain: 1, sent: 1 });
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_OUTBOX_MESSAGES.ko.uncertain}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect((await rows()).map((row) => [row.kind, row.status])).toEqual([
      ["reply", "uncertain"],
      ["failure_notice", "sent"],
    ]);
    expect(await outbox.settle(claim, { status: "sent", slackTs: "1.2" })).toBe(
      false,
    );
  });

  test("an uncertain reply a pass died before telling about is told once later", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    // As expireSending leaves it, with no notice enqueued after.
    await db
      .update(slackOutbox)
      .set({ status: "uncertain", errorCode: "lease_expired" });

    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    expect(posted().map((message) => message.text)).toEqual([
      expect.stringContaining(SLACK_OUTBOX_MESSAGES.ko.uncertain),
    ]);
    expect((await rows()).map((row) => [row.kind, row.status])).toEqual([
      ["reply", "uncertain"],
      ["failure_notice", "sent"],
    ]);
  });

  test("a pass that died after claiming but before sending leaves the row to be sent once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    await db
      .update(slackOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` });

    expect(await outboxPass()).toMatchObject({ uncertain: 0, sent: 1 });
    expect(posted()).toHaveLength(1);
    expect(await outbox.beginSend(claim)).toBe(false);
  });

  test("claims that never reached Slack spend no attempts", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    for (let lapse = 0; lapse < 5; lapse += 1) {
      expect(await outbox.claim({ limit: 10, leaseMs: 30_000 })).toHaveLength(
        1,
      );
      await db
        .update(slackOutbox)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` });
    }
    slack.failures.set("chat.postMessage", "internal_error");
    expect(await outboxPass()).toMatchObject({ retried: 1, failed: 0 });
    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 1,
    });
  });

  test("two passes at once send each row once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    const results = await Promise.all([outboxPass(), outboxPass()]);
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
    expect(posted()).toHaveLength(1);
  });

  test("a status Slack will not set leaves the answer sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.failures.set("agents.sessions.setStatus", "not_authorized");
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect((await rows())[0]).toMatchObject({ status: "sent" });
    expect(
      logged.some(
        (record) =>
          record.message === "Slack setStatus after the answer failed",
      ),
    ).toBe(true);
  });

  test("without a master key rows wait unsent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    expect(await outboxPass({ botToken: null })).toMatchObject({
      enqueued: 1,
      claimed: 0,
    });
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("a bot token that will not load fails the row on the fifth attempt", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await outboxPass({ botToken: async () => null });
      expect((await rows())[0]).toMatchObject({
        status: attempt < 5 ? "pending" : "failed",
        errorCode: "no_bot_token",
        attempts: attempt,
      });
      await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    }
    expect(posted()).toEqual([]);
  });

  test("a send with no answer is uncertain; the bot token is in no log line or row", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const down = createSlackBotApi({ apiUrl: "http://127.0.0.1:1/api" });
    expect(await outboxPass({ slack: down })).toMatchObject({ uncertain: 2 });
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "unreachable"],
      ["failure_notice", "uncertain", "unreachable"],
    ]);
    await outboxPass();
    expect(posted()).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain(BOT_CREDENTIAL);
    expect(JSON.stringify(await rows())).not.toContain(BOT_CREDENTIAL);
  });

  test("a reply whose send got no answer is never resent, and the thread hears so once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    const live = createSlackBotApi({ apiUrl: slack.url });
    let dropped = false;
    const flaky = {
      ...live,
      postMessage: (...args: Parameters<typeof live.postMessage>) => {
        if (dropped) return live.postMessage(...args);
        dropped = true;
        return Promise.reject(
          new SlackApiError("chat.postMessage", "timeout", false),
        );
      },
    };
    expect(await outboxPass({ slack: flaky })).toMatchObject({
      uncertain: 1,
      sent: 1,
    });
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_OUTBOX_MESSAGES.ko.uncertain}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "timeout"],
      ["failure_notice", "sent", null],
    ]);
    expect(JSON.stringify(logged)).not.toContain(BOT_CREDENTIAL);
    expect(JSON.stringify(await rows())).not.toContain(BOT_CREDENTIAL);
  });
});

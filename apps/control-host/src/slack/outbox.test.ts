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
  agentCardSchema,
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
import { createLogger, type LogRecord } from "@werft-ai/observability";
import {
  type Caller,
  callerFor,
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
import { migrate } from "drizzle-orm/pglite/migrator";
import { Pool } from "pg";
import {
  loadSessionCatalog,
  PROFILES_FILE,
  REPOSITORIES_FILE,
} from "../api/catalog-config.ts";
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
    slack.statuses.length = 0;
    slack.messages.length = 0;
    slack.failures.clear();
    slack.missingTs.clear();
    logged.length = 0;
  }, 60_000);
  afterEach(() => close());
}

async function loadCatalog() {
  if (root) return;
  root = await mkdtemp(join(tmpdir(), "slack-outbox-"));
  await writeFile(join(root, PROFILES_FILE), PROFILES);
  await writeFile(join(root, REPOSITORIES_FILE), "repositories: {}\n");
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
    card: agentCardSchema.parse({
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
    mode: "mention",
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

const text = (value: string) => ({ type: "text", text: value });
const toolUse = { type: "tool_use", id: "tu1", name: "Read", input: {} };

/** Ends turn `sequence` as the worker would, with these assistant events. */
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
  for (const content of said) {
    sourceSequence += 1;
    await db.insert(events).values({
      sessionId,
      turnId: turn.id,
      attemptId,
      sourceSequence,
      type: "assistant",
      payload: {
        type: "assistant",
        parent_tool_use_id: null,
        message: { role: "assistant", content },
      },
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

const rows = () => db.select().from(slackOutbox).orderBy(asc(slackOutbox.seq));

const posted = () =>
  slack.messages.filter((message) => message.method === "chat.postMessage");

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
        text: `Done: ping &lt;!here&gt;, &lt;@U0ELSE&gt; and <@${PERSON}>, but \`<!here>\` stays code.\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.link}>`,
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
      SLACK_NOTICE_MESSAGES.failed,
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
    await outbox.untoldUncertain(10);
    const explain = async (captured: string | undefined) => {
      const { query, params } = JSON.parse(captured ?? "{}");
      const client = await (
        db as unknown as { $client: Pool }
      ).$client.connect();
      try {
        // Tables this small would be read whole; ask which index it would use.
        await client.query("SET enable_seqscan = off");
        const { rows } = await client.query(
          `EXPLAIN (COSTS OFF) ${query}`,
          params,
        );
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        client.release(true);
      }
    };
    const turnsPlan = await explain(plans[0]);
    // turns_pkey only to fetch the open turns found per link.
    expect(turnsPlan).toContain("Index Cond: (id = ANY (");
    // Ranged on the link and its mark, not a walk of the whole index.
    expect(turnsPlan).toMatch(
      /turns_session_sequence_uniq[\s\S]*Index Cond: \(\(session_id = [^)]+\) AND \(sequence > /,
    );
    expect(await explain(plans.at(-1))).toContain("slack_outbox_uncertain_idx");
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
      `…\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.link}>`,
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
      `${SLACK_NOTICE_MESSAGES.failed}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.link}>`,
    ]);
    expect((await rows()).map((row) => row.kind)).toEqual(["failure_notice"]);
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

  test("a turn waiting on an approval says so once, while a client can still answer", async () => {
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

    await db.insert(pendingRequests).values({
      requestId: `req-${attemptId}`,
      sessionId,
      turnId: turn?.id ?? 0,
      attemptId,
      kind: "permission",
      payload: { kind: "permission", tool: "Bash", input: null },
      inputHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await outboxPass();
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_OUTBOX_MESSAGES.needsInput}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.link}>`,
    ]);
    expect((await rows()).map((row) => row.kind)).toEqual(["input_notice"]);
    // The turn is still going: its status line stays.
    expect(slack.statuses.map((status) => status.status)).not.toContain(
      "active",
    );

    // Answered on the web while a second notice waited: it is not sent.
    await db
      .update(turns)
      .set({ sequence: 2 })
      .where(eq(turns.id, turn?.id ?? 0));
    await outboxPass({ botToken: null });
    await db.delete(pendingRequests);
    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    expect(posted()).toHaveLength(1);
    expect((await rows()).map((row) => [row.kind, row.errorCode])).toEqual([
      ["input_notice", null],
      ["input_notice", "not_addressed"],
    ]);
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
        text: `${SLACK_NOTICE_MESSAGES.connect}\n\n<${CONSOLE}/settings/linked-accounts|${SLACK_OUTBOX_MESSAGES.link}>`,
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
      `${SLACK_OUTBOX_MESSAGES.uncertain}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.link}>`,
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
      expect.stringContaining(SLACK_OUTBOX_MESSAGES.uncertain),
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
      `${SLACK_OUTBOX_MESSAGES.uncertain}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.link}>`,
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

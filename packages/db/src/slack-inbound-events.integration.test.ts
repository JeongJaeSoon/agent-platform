import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { type SlackInboundEventInput, SecretKey } from "@werft-ai/platform";
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
  agents,
  slackApps,
  slackInboundEvents,
  slackInstallations,
  workspaces,
} from "./schema.ts";
import { createPostgresSlackAppStore } from "./slack-apps.ts";
import { createPostgresSlackInboundEventStore } from "./slack-inbound-events.ts";
import { createPostgresSlackInstallStore } from "./slack-install-states.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("slack_inbound_events on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_inbox_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  // Fixture ids shaped like Slack's; no Slack app is involved.
  const slackId = (prefix: string) =>
    `${prefix}${randomBytes(4).toString("hex").toUpperCase()}`;

  async function agentApp(state: "created" | "deleted" = "created") {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      slug: `a-${agentId.slice(0, 8)}`,
      name: "Notes",
    });
    const slackAppId = randomUUID();
    const appId = slackId("A");
    await db.insert(slackApps).values({
      id: slackAppId,
      workspaceId,
      kind: "agent",
      agentId,
      state,
      appId,
      clientId: "1.1",
      redirectUrl: "https://console.example/cb",
    });
    return { workspaceId, agentId, slackAppId, appId };
  }

  const event = (
    app: Awaited<ReturnType<typeof agentApp>>,
    teamId: string,
    eventId: string,
  ) => ({
    workspaceId: app.workspaceId,
    agentId: app.agentId,
    slackAppId: app.slackAppId,
    teamId,
    appId: app.appId,
    eventId,
    eventType: "app_mention",
    eventSubtype: null,
    eventTime: new Date("2026-10-24T10:00:00Z"),
  });

  test("one row per (team_id, event_id), dropped or not", async () => {
    const app = await agentApp();
    const inbox = createPostgresSlackInboundEventStore(db);
    const team = slackId("T");
    const received: SlackInboundEventInput = {
      ...event(app, team, "Ev01"),
      status: "received",
      payload: { type: "event_callback", event_id: "Ev01" },
    };
    expect(await inbox.seen(team, "Ev01")).toBe(false);
    expect(await inbox.record(received)).toBe("recorded");
    expect(await inbox.seen(team, "Ev01")).toBe(true);
    expect(await inbox.record(received)).toBe("duplicate");
    const dropped: SlackInboundEventInput = {
      ...event(app, team, "Ev02"),
      status: "dropped",
      dropReason: "bot_message",
    };
    expect(await inbox.record(dropped)).toBe("recorded");
    expect(
      await inbox.record({
        ...event(app, team, "Ev02"),
        status: "received",
        payload: {},
      }),
    ).toBe("duplicate");
    // Another team may reuse the id.
    expect(
      await inbox.record({ ...received, teamId: slackId("T") }),
    ).toBe("recorded");

    const rows = await db
      .select()
      .from(slackInboundEvents)
      .where(eq(slackInboundEvents.agentId, app.agentId));
    expect(rows).toHaveLength(3);
    const drop = rows.find((row) => row.eventId === "Ev02");
    expect(drop).toMatchObject({
      status: "dropped",
      dropReason: "bot_message",
      payload: null,
    });
  });

  test("the table refuses a dropped row with a payload or a reason on a kept one", async () => {
    const app = await agentApp();
    const base = {
      id: randomUUID(),
      ...event(app, slackId("T"), "Ev03"),
    };
    // The builder is only thenable; `rejects` wants a promise.
    const insert = (values: typeof slackInboundEvents.$inferInsert) =>
      Promise.resolve(db.insert(slackInboundEvents).values(values));
    await expect(
      insert({
        ...base,
        status: "dropped",
        dropReason: "bot_message",
        payload: {},
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        ...base,
        status: "received",
        dropReason: "bot_message",
        payload: {},
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        ...base,
        status: "dropped",
        dropReason: "not_a_reason" as never,
      }),
    ).rejects.toThrow();
  });

  test("findAgentApp finds only a created agent app, by agent id alone", async () => {
    const apps = createPostgresSlackAppStore(db, key);
    const live = await agentApp();
    const gone = await agentApp("deleted");
    expect((await apps.findAgentApp(live.agentId))?.id).toBe(live.slackAppId);
    expect(await apps.findAgentApp(gone.agentId)).toBeNull();
    expect(await apps.findAgentApp(randomUUID())).toBeNull();
    expect(await apps.findAgentApp("nope")).toBeNull();
    expect(
      await apps.manifestAgent(live.workspaceId, live.agentId),
    ).toMatchObject({ id: live.agentId, name: "Notes" });
    expect(await apps.manifestAgent(randomUUID(), live.agentId)).toBeNull();
  });

  test("revokeInstallation revokes the install and reports a missing one", async () => {
    const app = await agentApp();
    const installs = createPostgresSlackInstallStore(db);
    const teamId = slackId("T");
    await installs.recordInstallation({
      workspaceId: app.workspaceId,
      appId: app.appId,
      teamId,
      botUserId: slackId("U"),
    });
    expect(await installs.revokeInstallation({ appId: app.appId, teamId })).toBe(
      "revoked",
    );
    expect(await installs.revokeInstallation({ appId: app.appId, teamId })).toBe(
      "revoked",
    );
    const [row] = await db
      .select({ status: slackInstallations.status })
      .from(slackInstallations)
      .where(eq(slackInstallations.appId, app.appId));
    expect(row?.status).toBe("revoked");
    expect(
      await installs.revokeInstallation({
        appId: app.appId,
        teamId: slackId("T"),
      }),
    ).toBe("not_found");
  });
});

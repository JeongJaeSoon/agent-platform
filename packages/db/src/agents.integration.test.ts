import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentCard,
  agentCardSchema,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  type CatalogProfile,
  callerFor,
  cardContentSha256,
  createAgentService,
  createAuthorizationPolicy,
  deriveReleaseId,
  InvalidCursorError,
  resolveReleaseContent,
  type SessionCatalog,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import * as schema from "./schema.ts";
import {
  agentActivationEvents,
  agentReleases,
  agents,
  agentVersions,
  memberships,
  receipts,
  sessions,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const PAGE = { limit: 50 };

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const CATALOG: SessionCatalog = {
  profiles: { coding: PROFILE },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["coding"],
    },
  },
};

function cardWith(instructions: string, tools: string[] | null = ["Read"]) {
  return agentCardSchema.parse({
    role: "재무 분석가",
    instructions,
    model: "claude-sonnet-5",
    capabilities: { tools, mcp: null, forbidden: [] },
  });
}

// What PostgreSQL said; Drizzle wraps it as the cause of its own error.
async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String((error as { cause?: Error }).cause?.message ?? error);
  }
  return "accepted";
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  return "ok";
}

integration("agents, versions, releases and activation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agents_it" });
    pool = new Pool({ connectionString: database.url, max: 16 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  function service(catalog: SessionCatalog = CATALOG): AgentService {
    return createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog,
      credentials: createPostgresCredentialBindingStore(db),
    });
  }

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: "owner" | "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  function serviceKey(workspaceId: string): Caller {
    return callerFor(
      {
        kind: "api_key",
        id: randomUUID(),
        owner_id: workspaceId,
        workspace_id: workspaceId,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      randomUUID(),
      { creatorId: null },
    );
  }

  async function newAgent(
    agents: AgentService,
    owner: Caller,
    card: AgentCard = cardWith("v1"),
  ) {
    return agents.createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "재무 분석가",
      card,
    });
  }

  // Rows straight into agents, so created_at can tie and differ by 1µs.
  async function seedAgents(workspaceId: string, createdAt: string[]) {
    const ids: string[] = createdAt.map(() => randomUUID());
    await pool.query(
      `INSERT INTO agents (id, workspace_id, slug, name, created_at)
       SELECT id, $1, 'seed-' || id, 'seed', at
       FROM unnest($2::uuid[], $3::timestamptz[]) AS seed(id, at)`,
      [workspaceId, ids, createdAt],
    );
    return ids;
  }

  async function walk(
    agentsService: AgentService,
    caller: Caller,
    limit: number,
  ) {
    const pages: { ids: string[]; next_cursor: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await agentsService.listAgents(caller, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      pages.push({
        ids: page.items.map((agent) => agent.id),
        next_cursor: page.next_cursor,
      });
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return pages;
  }

  async function idsInOrder(workspaceId: string) {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .orderBy(asc(agents.createdAt), asc(agents.id));
    return rows.map((row) => row.id);
  }

  test("pages walk created_at, id oldest first through ties and microseconds, and only the last page has no next_cursor", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const tie = "2026-01-01 00:00:00.000001+00";
    await seedAgents(workspaceId, [
      tie,
      tie,
      tie,
      "2026-01-01 00:00:00.000002+00",
      "2026-01-01 00:00:00+00",
      tie,
      "2026-01-02 00:00:00+00",
    ]);
    const pages = await walk(agentsService, owner, 3);
    expect(pages.map((page) => page.ids.length)).toEqual([3, 3, 1]);
    expect(pages.map((page) => page.next_cursor === null)).toEqual([
      false,
      false,
      true,
    ]);
    expect(pages.flatMap((page) => page.ids)).toEqual(
      await idsInOrder(workspaceId),
    );

    // Exactly limit agents: one full page, nothing after it.
    const exact = await workspace();
    const exactOwner = await person(exact, "owner");
    await seedAgents(exact, [tie, tie, tie]);
    expect(await walk(agentsService, exactOwner, 3)).toEqual([
      { ids: await idsInOrder(exact), next_cursor: null },
    ]);
  });

  test("more than the old 500 cap are all listed, and no cursor reads the first 50", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    await seedAgents(
      workspaceId,
      Array.from({ length: 501 }, (_, i) =>
        new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      ),
    );
    const all = await idsInOrder(workspaceId);
    const first = await agentsService.listAgents(owner, PAGE);
    expect(first.items.map((agent) => agent.id)).toEqual(all.slice(0, 50));
    expect(first.next_cursor).not.toBeNull();
    const pages = await walk(agentsService, owner, 100);
    expect(pages.map((page) => page.ids.length)).toEqual([
      100, 100, 100, 100, 100, 1,
    ]);
    expect(pages.flatMap((page) => page.ids)).toEqual(all);
  });

  test("agents created during a walk never duplicate or hide the ones that were there", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const before = await seedAgents(
      workspaceId,
      Array.from({ length: 9 }, (_, i) => `2026-01-01 00:00:0${i}+00`),
    );
    const seen: string[] = [];
    const first = await agentsService.listAgents(owner, { limit: 4 });
    seen.push(...first.items.map((agent) => agent.id));
    let cursor = first.next_cursor;
    // Behind the cursor, between pages and after the end, while the walk runs.
    const inserts = Promise.all([
      seedAgents(workspaceId, ["2025-12-31 00:00:00+00"]),
      seedAgents(workspaceId, ["2026-01-01 00:00:03.5+00"]),
      seedAgents(workspaceId, ["2026-01-01 00:00:06.5+00"]),
      newAgent(agentsService, owner),
    ]);
    while (cursor) {
      const page = await agentsService.listAgents(owner, { limit: 4, cursor });
      seen.push(...page.items.map((agent) => agent.id));
      cursor = page.next_cursor;
    }
    await inserts;
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of before) {
      expect(seen.filter((one) => one === id)).toHaveLength(1);
    }
  });

  test("a cursor only positions: another workspace's cursor shows nothing of that workspace, and a forged one is refused", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const me = await person(mine, "owner");
    const them = await person(theirs, "owner");
    const member = await person(theirs, "member");
    const agentsService = service();
    await seedAgents(mine, ["2026-01-01 00:00:00+00"]);
    const theirIds = await seedAgents(theirs, [
      "2026-01-01 00:00:00+00",
      "2026-01-01 00:00:01+00",
      "2026-01-01 00:00:02+00",
    ]);
    const theirCursor = (await agentsService.listAgents(them, { limit: 1 }))
      .next_cursor;
    expect(theirCursor).not.toBeNull();
    const page = await agentsService.listAgents(me, {
      limit: 50,
      cursor: theirCursor ?? "",
    });
    expect(page.items.some((agent) => theirIds.includes(agent.id))).toBe(false);
    expect(page.items.every((agent) => agent.workspace_id === mine)).toBe(true);

    // The cursor does not lift the role check on the next page.
    expect(
      await codeOf(
        agentsService.listAgents(member, {
          limit: 1,
          cursor: theirCursor ?? "",
        }),
      ),
    ).toBe("FORBIDDEN");

    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const forged of [
      "not-a-cursor",
      encode({ created_at: "2026-01-01", id: randomUUID() }),
      encode({ created_at: "2026-13-01 00:00:00+00", id: randomUUID() }),
      encode({ created_at: "2026-01-01 00:00:00+00", id: "x" }),
    ]) {
      const refused = await agentsService
        .listAgents(them, { limit: 1, cursor: forged })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused, forged).toBeInstanceOf(InvalidCursorError);
    }
  });

  test("an owner creates an agent, adds versions, releases and activates one", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();

    const created = await newAgent(agentsService, owner);
    expect(created.agent).toMatchObject({
      workspace_id: workspaceId,
      status: "active",
      active_release_id: null,
      activation_revision: -1,
      created_by: owner.actor?.userId,
    });
    expect(created.versions.map((version) => version.version_no)).toEqual([1]);
    const first = created.versions[0];
    if (!first) throw new Error("no version 1");

    const edited = await agentsService.updateAgent(owner, created.agent.id, {
      name: "재무 분석가 2",
      card: cardWith("v2"),
    });
    expect(edited.agent.name).toBe("재무 분석가 2");
    expect(edited.versions.map((version) => version.version_no)).toEqual([
      1, 2,
    ]);
    expect(edited.versions[0]).toEqual(first);
    const again = await agentsService.updateAgent(owner, created.agent.id, {
      card: cardWith("v2"),
    });
    expect(again.versions).toHaveLength(2);

    const second = edited.versions[1];
    if (!second) throw new Error("no version 2");
    const released = await agentsService.createRelease(
      owner,
      created.agent.id,
      {
        version_id: second.id,
        runtime_profile_id: "coding",
      },
    );
    expect(released.created).toBe(true);
    expect(released.release).toMatchObject({
      agent_id: created.agent.id,
      version_id: second.id,
      card_sha256: second.content_sha256,
      effective_tools: { tools: ["Read"], mcp: [] },
      created_by: owner.actor?.userId,
      approved_by: null,
      approved_at: null,
    });
    expect(JSON.stringify(released.release)).not.toContain(
      "catalog-provider-key",
    );
    const rereleased = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: second.id, runtime_profile_id: "coding" },
    );
    expect(rereleased).toEqual({ release: released.release, created: false });

    const before = await agentsService.getAgent(owner, created.agent.id);
    expect(before.active_release).toBeNull();

    const activated = await agentsService.activateAgent(
      owner,
      created.agent.id,
      { release_id: released.release.id, expected_revision: -1 },
    );
    expect(activated).toMatchObject({
      active_release_id: released.release.id,
      previous_release_id: null,
      activation_revision: 0,
    });
    expect(activated.receipt_id).not.toBeNull();
    expect(
      await agentsService.activateAgent(owner, created.agent.id, {
        release_id: released.release.id,
        expected_revision: -1,
      }),
    ).toEqual({
      active_release_id: released.release.id,
      previous_release_id: null,
      activation_revision: 0,
      receipt_id: null,
    });

    const detail = await agentsService.getAgent(owner, created.agent.id);
    expect(detail.agent.active_release_id).toBe(released.release.id);
    expect(detail.active_release?.approved_by).toBe(owner.actor?.userId);
    expect(detail.releases).toHaveLength(1);
    const list = await agentsService.listAgents(owner, PAGE);
    expect(list.items.map((agent) => agent.id)).toEqual([created.agent.id]);
  });

  test("release creation and activation are separate audit rows with their own actors", async () => {
    const workspaceId = await workspace();
    const author = await person(workspaceId, "owner");
    const approver = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, author);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const { release } = await agentsService.createRelease(
      author,
      created.agent.id,
      { version_id: version.id, runtime_profile_id: "coding" },
    );

    let events = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, created.agent.id));
    expect(events.map((event) => event.kind)).toEqual(["release_created"]);
    const [stored] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, release.id));
    expect(stored?.approvedBy).toBeNull();

    await agentsService.activateAgent(approver, created.agent.id, {
      release_id: release.id,
      expected_revision: -1,
    });
    events = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, created.agent.id))
      .orderBy(asc(agentActivationEvents.createdAt));
    expect(
      events.map((event) => ({
        kind: event.kind,
        actor: event.actorUserId,
        release: event.releaseId,
        revision: event.activationRevision,
      })),
    ).toEqual([
      {
        kind: "release_created",
        actor: author.actor?.userId as string,
        release: release.id,
        revision: null,
      },
      {
        kind: "activated",
        actor: approver.actor?.userId as string,
        release: release.id,
        revision: 0,
      },
    ]);
    const [approved] = await db
      .select()
      .from(agentReleases)
      .where(eq(agentReleases.id, release.id));
    expect(approved?.approvedBy).toBe(approver.actor?.userId as string);
    expect(approved?.createdBy).toBe(author.actor?.userId as string);

    for (const event of events) {
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, event.receiptId));
      expect(receipt?.operation).toBe(
        event.kind === "activated" ? "activate_agent" : "create_agent_release",
      );
      expect(receipt?.actor).toEqual({
        principal: { kind: "user", id: event.actorUserId },
        actor_user_id: event.actorUserId,
        agent_id: null,
      });
      expect(receipt?.targetRef).toEqual({
        resource: { kind: "agent", id: created.agent.id },
        workspace_id: workspaceId,
      });
    }
  });

  test("of ten concurrent activations one wins and nine see REVISION_CONFLICT", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("c0"));
    const releaseIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const detail = await agentsService.updateAgent(owner, created.agent.id, {
        card: cardWith(`c${index + 1}`),
      });
      const version = detail.versions.at(-1);
      if (!version) throw new Error("no version");
      const { release } = await agentsService.createRelease(
        owner,
        created.agent.id,
        { version_id: version.id, runtime_profile_id: "coding" },
      );
      releaseIds.push(release.id);
    }
    expect(new Set(releaseIds).size).toBe(10);

    const outcomes = await Promise.all(
      releaseIds.map((releaseId) =>
        codeOf(
          agentsService.activateAgent(owner, created.agent.id, {
            release_id: releaseId,
            expected_revision: -1,
          }),
        ),
      ),
    );
    expect(outcomes.filter((outcome) => outcome === "ok")).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome === "REVISION_CONFLICT"),
    ).toHaveLength(9);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.agent.id));
    expect(agent?.activationRevision).toBe(0);
    const winner = releaseIds[outcomes.indexOf("ok")];
    expect(agent?.activeReleaseId).toBe(winner as string);
    const activated = await db
      .select()
      .from(agentActivationEvents)
      .where(eq(agentActivationEvents.agentId, created.agent.id));
    expect(activated.filter((row) => row.kind === "activated")).toHaveLength(1);

    const next = releaseIds.find((id) => id !== winner) as string;
    expect(
      await agentsService.activateAgent(owner, created.agent.id, {
        release_id: next,
        expected_revision: 0,
      }),
    ).toMatchObject({
      active_release_id: next,
      previous_release_id: winner,
      activation_revision: 1,
    });
  });

  test("a release refuses to resolve once its profile has changed", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const created = await newAgent(service(), owner);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const { release } = await service().createRelease(owner, created.agent.id, {
      version_id: version.id,
      runtime_profile_id: "coding",
    });

    const edited = service({
      ...CATALOG,
      profiles: { coding: { ...PROFILE, tools: ["Read", "Grep"] } },
    });
    expect(await codeOf(edited.resolveRelease(workspaceId, release.id))).toBe(
      "PROFILE_DIGEST_MISMATCH",
    );
    expect(
      await codeOf(
        edited.activateAgent(owner, created.agent.id, {
          release_id: release.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
    const rereleased = await edited.createRelease(owner, created.agent.id, {
      version_id: version.id,
      runtime_profile_id: "coding",
    });
    expect(rereleased.release.id).not.toBe(release.id);
    expect(
      (await edited.resolveRelease(workspaceId, rereleased.release.id)).id,
    ).toBe(rereleased.release.id);
  });

  test("an agent id in upper case releases and activates the same release", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const created = await newAgent(service(), owner);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const upper = created.agent.id.toUpperCase();
    const { release } = await service().createRelease(owner, upper, {
      version_id: version.id,
      runtime_profile_id: "coding",
    });
    const lower = await service().createRelease(owner, created.agent.id, {
      version_id: version.id,
      runtime_profile_id: "coding",
    });
    expect(lower).toEqual({ release, created: false });
    const activated = await service().activateAgent(owner, upper, {
      release_id: release.id,
      expected_revision: -1,
    });
    expect(activated.active_release_id).toBe(release.id);
  });

  test("a card asking for more than the profile allows is not released", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const created = await newAgent(
      service(),
      owner,
      cardWith("wide", ["Read", "WebFetch"]),
    );
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    expect(
      await codeOf(
        service().createRelease(owner, created.agent.id, {
          version_id: version.id,
          runtime_profile_id: "coding",
        }),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      await codeOf(
        service().createRelease(owner, created.agent.id, {
          version_id: version.id,
          runtime_profile_id: "missing",
        }),
      ),
    ).toBe("UNSUPPORTED_CAPABILITY");
  });

  test("another agent's version or release is not found, and the database refuses the pairing too", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const a = await newAgent(agentsService, owner, cardWith("a"));
    const b = await newAgent(agentsService, owner, cardWith("b"));
    const versionOfB = b.versions[0];
    if (!versionOfB) throw new Error("no version");
    expect(
      await codeOf(
        agentsService.createRelease(owner, a.agent.id, {
          version_id: versionOfB.id,
          runtime_profile_id: "coding",
        }),
      ),
    ).toBe("NOT_FOUND");
    const { release: releaseOfB } = await agentsService.createRelease(
      owner,
      b.agent.id,
      { version_id: versionOfB.id, runtime_profile_id: "coding" },
    );
    expect(
      await codeOf(
        agentsService.activateAgent(owner, a.agent.id, {
          release_id: releaseOfB.id,
          expected_revision: -1,
        }),
      ),
    ).toBe("NOT_FOUND");

    expect(
      await refusal(
        db
          .update(agents)
          .set({ activeReleaseId: releaseOfB.id, activationRevision: 0 })
          .where(eq(agents.id, a.agent.id)),
      ),
    ).toMatch(/agents_active_release_fk/);
    expect(
      await refusal(
        db.insert(agentReleases).values({
          id: `sha256:${"0".repeat(64)}`,
          agentId: a.agent.id,
          versionId: versionOfB.id,
          cardSha256: versionOfB.content_sha256,
          runtimeProfileId: "coding",
          profileDigest: "sha256:x",
          runtimeConfigSnapshot: {},
          effectiveTools: { tools: [], mcp: [] },
        }),
      ),
    ).toMatch(/agent_releases_version_fk/);

    const elsewhere = await person(await workspace(), "owner");
    expect(await codeOf(agentsService.getAgent(elsewhere, a.agent.id))).toBe(
      "NOT_FOUND",
    );
    expect((await agentsService.listAgents(elsewhere, PAGE)).items).toEqual([]);
  });

  test("versions and releases cannot be rewritten in place", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner);
    const version = created.versions[0];
    if (!version) throw new Error("no version");
    const { release } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: version.id, runtime_profile_id: "coding" },
    );
    expect(
      await refusal(
        db
          .update(agentVersions)
          .set({ card: cardWith("rewritten") })
          .where(eq(agentVersions.id, version.id)),
      ),
    ).toMatch(/insert-only/);
    expect(
      await refusal(
        db
          .update(agentReleases)
          .set({ effectiveTools: { tools: ["Bash"], mcp: [] } })
          .where(eq(agentReleases.id, release.id)),
      ),
    ).toMatch(/insert-only/);
    expect(
      await refusal(
        db.delete(agentReleases).where(eq(agentReleases.id, release.id)),
      ),
    ).toMatch(/insert-only/);
  });

  test("a session keeps the release it was pinned to when the agent is activated anew", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("p1"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const { release: r1 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v1.id, runtime_profile_id: "coding" },
    );
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r1.id,
      expected_revision: -1,
    });
    // Pinning happens at session creation (94S-157); the row is what it pins.
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      agentReleaseId: r1.id,
    });
    expect(
      await refusal(
        db.insert(sessions).values({
          id: randomUUID(),
          ownerId: workspaceId,
          repoUrl: "https://example.invalid/app.git",
          branch: "main",
          agentReleaseId: "sha256:nowhere",
        }),
      ),
    ).toMatch(/sessions_agent_release_id_agent_releases_id_fk/);

    const v2 = (
      await agentsService.updateAgent(owner, created.agent.id, {
        card: cardWith("p2"),
      })
    ).versions[1];
    if (!v2) throw new Error("no version 2");
    const { release: r2 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v2.id, runtime_profile_id: "coding" },
    );
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r2.id,
      expected_revision: 0,
    });
    const [session] = await db
      .select({ agentReleaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.agentReleaseId).toBe(r1.id);
  });

  test("a policy change is a new release; a pinned session keeps the policy it started with", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const withPolicy = (bash: "ask" | "deny") =>
      agentCardSchema.parse({
        ...cardWith("policy", ["Read", "Bash"]),
        capabilities: {
          tools: ["Read", "Bash"],
          mcp: null,
          forbidden: [],
          tool_policy: { per_tool: { Bash: bash } },
        },
      });
    const created = await newAgent(agentsService, owner, withPolicy("ask"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const { release: r1 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v1.id, runtime_profile_id: "coding" },
    );
    expect(r1.policy_pins).toEqual({
      tools: {
        default: { builtin: "allow", mcp: "ask" },
        per_tool: { Read: "allow", Bash: "ask" },
      },
    });
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r1.id,
      expected_revision: -1,
    });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      agentReleaseId: r1.id,
    });

    const updated = await agentsService.updateAgent(owner, created.agent.id, {
      card: withPolicy("deny"),
    });
    const v2 = updated.versions[1];
    if (!v2) throw new Error("a policy change did not make a version");
    const { release: r2 } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v2.id, runtime_profile_id: "coding" },
    );
    expect(r2.id).not.toBe(r1.id);
    expect(r2.policy_pins.tools?.per_tool.Bash).toBe("deny");
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: r2.id,
      expected_revision: 0,
    });

    const [session] = await db
      .select({ agentReleaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session?.agentReleaseId).toBe(r1.id);
    const pinned = await agentsService.resolveRelease(
      workspaceId,
      session?.agentReleaseId ?? "",
    );
    expect(pinned.policy_pins.tools?.per_tool.Bash).toBe("ask");
  });

  test("a release stored before tool policies still reads, verifies and activates", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentsService = service();
    const created = await newAgent(agentsService, owner, cardWith("legacy"));
    const v1 = created.versions[0];
    if (!v1) throw new Error("no version");
    const resolved = resolveReleaseContent(v1.card, "coding", PROFILE);
    if (!resolved.ok) throw new Error(resolved.error.message);
    // What 94S-154 wrote: the same content with the `{}` placeholder.
    const identity = {
      ...resolved.content,
      agent_id: created.agent.id,
      card_sha256: cardContentSha256(v1.card),
      policy_pins: {},
    };
    const legacyId = deriveReleaseId(identity);
    await db.insert(agentReleases).values({
      id: legacyId,
      agentId: identity.agent_id,
      versionId: v1.id,
      cardSha256: identity.card_sha256,
      runtimeProfileId: identity.runtime_profile_id,
      profileDigest: identity.profile_digest,
      runtimeConfigSnapshot: identity.runtime_config_snapshot,
      effectiveTools: identity.effective_tools,
      policyPins: {},
      createdBy: owner.actor?.userId ?? null,
    });

    const detail = await agentsService.getAgent(owner, created.agent.id);
    expect(detail.releases.map((release) => release.policy_pins)).toEqual([{}]);
    expect(
      (await agentsService.resolveRelease(workspaceId, legacyId)).policy_pins,
    ).toEqual({});
    await agentsService.activateAgent(owner, created.agent.id, {
      release_id: legacyId,
      expected_revision: -1,
    });
    // Releasing the same version now pins a policy, so it is another release.
    const { release } = await agentsService.createRelease(
      owner,
      created.agent.id,
      { version_id: v1.id, runtime_profile_id: "coding" },
    );
    expect(release.id).not.toBe(legacyId);
    expect(release.policy_pins.tools?.per_tool).toEqual({ Read: "allow" });
  });

  test("members and API keys cannot manage agents; a slug is taken once", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const agentsService = service();
    const created = await newAgent(agentsService, owner);

    for (const caller of [member, serviceKey(workspaceId)]) {
      expect(await codeOf(agentsService.listAgents(caller, PAGE))).toBe(
        "FORBIDDEN",
      );
      expect(
        await codeOf(agentsService.getAgent(caller, created.agent.id)),
      ).toBe("FORBIDDEN");
      expect(
        await codeOf(
          agentsService.createAgent(caller, {
            slug: "by-someone-else",
            name: "x",
            card: cardWith("x"),
          }),
        ),
      ).toBe("FORBIDDEN");
    }
    expect(
      await codeOf(
        agentsService.createAgent(owner, {
          slug: created.agent.slug,
          name: "duplicate",
          card: cardWith("dup"),
        }),
      ),
    ).toBe("ALREADY_EXISTS");
  });

  test("an owner offboarded after the decision cannot write", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const store = createPostgresAgentStore(db);
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, owner.actor?.userId as string));
    expect(
      await store.create({
        principal: owner,
        workspaceId,
        slug: "late",
        name: "late",
        card: cardWith("late"),
        contentSha256: "a".repeat(64),
        createdBy: owner.actor?.userId as string,
      }),
    ).toEqual({ outcome: "actor_inactive" });
  });
});

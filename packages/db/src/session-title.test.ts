import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type CatalogProfile,
  createAuthorizationPolicy,
  createSessionService,
  type SessionCatalog,
  SessionServiceError,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";

const OWNER = testCaller("owner-a");
const OTHER = testCaller("owner-b");

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://sonnet.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const CATALOG: SessionCatalog = {
  profiles: { sonnet: PROFILE },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["sonnet"],
    },
  },
};

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

afterEach(async () => {
  await client.close();
});

const service = () =>
  createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog: CATALOG,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });

async function create(body: { message: string; title?: string }) {
  const created = await service().createSession(OWNER, {
    idempotencyKey: crypto.randomUUID(),
    body: { profile_id: "sonnet", repository_id: "app", ...body },
  });
  return created.session_id;
}

async function statusEvents(sessionId: string) {
  const page = await service().readEvents(OWNER, sessionId, {
    limit: 100,
    maxBytes: 1_000_000,
  });
  return page.items.filter((item) => item.event === "status");
}

describe("session titles (94S-804)", () => {
  test("a given title and a derived one reach the list and the detail", async () => {
    const named = await create({ message: "hello", title: " Named\n one " });
    const derived = await create({
      message: "Fix the\n\nflaky   checkout test",
    });
    const blank = await create({ message: " \n " });

    expect((await service().getSession(OWNER, named)).title).toBe("Named one");
    expect((await service().getSession(OWNER, derived)).title).toBe(
      "Fix the flaky checkout test",
    );
    expect((await service().getSession(OWNER, blank)).title).toBeNull();

    const page = await service().listSessions(OWNER, { limit: 10 });
    expect(
      Object.fromEntries(page.items.map((item) => [item.id, item.title])),
    ).toEqual({
      [named]: "Named one",
      [derived]: "Fix the flaky checkout test",
      [blank]: null,
    });
  });

  test("a row from before the column reads null", async () => {
    const id = await create({ message: "hello" });
    await db.update(sessions).set({ title: null }).where(eq(sessions.id, id));
    expect((await service().getSession(OWNER, id)).title).toBeNull();
  });

  test("rename stores the title, keeps the revision and writes a status event carrying it", async () => {
    const id = await create({ message: "hello" });
    const before = await service().getSession(OWNER, id);
    const eventsBefore = (await statusEvents(id)).length;

    const renamed = await service().renameSession(OWNER, id, {
      title: "  Better\nname ",
    });
    expect(renamed.title).toBe("Better name");
    expect(renamed.revision).toBe(before.revision);
    expect((await service().getSession(OWNER, id)).title).toBe("Better name");

    const after = await statusEvents(id);
    expect(after).toHaveLength(eventsBefore + 1);
    expect(after.at(-1)?.data.data).toMatchObject({
      phase: before.status,
      admission_state: "active",
      title: "Better name",
    });
  });

  test("renaming to the same title writes no event", async () => {
    const id = await create({ message: "hello", title: "Same" });
    const count = (await statusEvents(id)).length;
    await service().renameSession(OWNER, id, { title: "Same" });
    expect(await statusEvents(id)).toHaveLength(count);
  });

  test("another owner's session is not found", async () => {
    const id = await create({ message: "hello" });
    const refused = await service()
      .renameSession(OTHER, id, { title: "Mine now" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("NOT_FOUND");
    expect((await service().getSession(OWNER, id)).title).toBe("hello");
  });
});

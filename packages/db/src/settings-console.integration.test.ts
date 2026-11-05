import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  parseSettingsDocument,
  SecretKey,
  type SettingsImportAdd,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresInstallationSettingsStore } from "./installation-settings.ts";
import * as schema from "./schema.ts";
import {
  mcpServers,
  memberships,
  providerConnections,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secret-values.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("ef".repeat(32), "test key");

/** The entry as the console service hands it over: stored under its own id. */
function add(
  section: "connections" | "repositories" | "mcp_servers",
  id: string,
  entry: Record<string, unknown>,
): SettingsImportAdd {
  const parsed = parseSettingsDocument({
    version: 1,
    connections: {},
    repositories: {},
    mcp_servers: {},
    [section]: { [id]: entry },
  });
  if (section === "connections") {
    return { kind: "connection", id, entry: parsed.connections[id] as never };
  }
  if (section === "mcp_servers") {
    return { kind: "mcp", id, entry: parsed.mcp_servers[id] as never };
  }
  return { kind: "repository", id, entry: parsed.repositories[id] as never };
}

const CONNECTION = {
  kind: "anthropic",
  endpoint: "http://fake-model:8080",
  billing: "none",
  auth: { kind: "api_key", stored: true },
};
const MCP = {
  url: "https://mcp.example.invalid/docs",
  credential_ref: "docs_token",
  auth: { kind: "bearer", stored: true },
  workspaces: ["acme"],
};

integration("settings console writes", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_console_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    const [made] = await db
      .insert(workspaces)
      .values({ id: randomUUID(), slug: "acme", name: "acme" })
      .returning({ id: workspaces.id });
    if (!made) throw new Error("no workspace");
    workspaceId = made.id;
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function person(role: WorkspaceRole): Promise<TeamActor> {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
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
    return { principal, workspaceId, userId };
  }

  const store = () => createPostgresSettingsDocumentStore(db, KEY);
  const settings = () => createPostgresInstallationSettingsStore(db, KEY);
  const receiptsOf = async (operation: string) =>
    db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, operation as never));

  test("a console connection is its row, its own sealed value and one receipt in one go, and the registry reads it", async () => {
    const owner = await person("owner");
    const made = await store().create(
      add("connections", "console-fake", CONNECTION),
      "example-key-1234",
      owner,
    );
    expect(made.outcome).toBe("done");
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, "console-fake"));
    expect(row).toMatchObject({
      origin: "console",
      credentialSource: "stored",
      definition: { auth: { stored: "connection:console-fake" } },
    });
    const read = await settings().read({ openStored: true });
    expect(read.connections.map((item) => item.id)).toContain("console-fake");
    expect(read.stored.get("connection:console-fake")).toBe("example-key-1234");
    const [receipt] = await receiptsOf("create_connection");
    expect(receipt?.result).toMatchObject({
      connection_id: "console-fake",
      credential_source: "stored",
      source: "console",
    });
    expect(JSON.stringify(receipt?.result)).not.toContain("example-key");

    const listed = await store().listRows("connection");
    expect(listed.find((item) => item.id === "console-fake")).toMatchObject({
      origin: "console",
      last4: "1234",
      disabledAt: null,
    });
  });

  test("an id ever taken or a value already sealed under it is refused, and nothing is written", async () => {
    const owner = await person("owner");
    expect(
      await store().create(
        add("connections", "console-fake", CONNECTION),
        "another-key",
        owner,
      ),
    ).toEqual({ outcome: "conflict", reason: "already_exists" });
    // A value sealed under an id no row holds yet (made before S2's row
    // check): a new row on that id would take it.
    await db.transaction((tx) =>
      writeSecretInTx(
        tx,
        KEY,
        {
          workspaceId,
          owner: { kind: "connection", id: "orphan" },
          purpose: "settings_credential",
        },
        "someone-elses-key",
        null,
      ),
    );
    expect(
      await store().create(
        add("connections", "orphan", CONNECTION),
        "mine",
        owner,
      ),
    ).toEqual({ outcome: "conflict", reason: "already_exists" });
    expect(
      await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, "orphan")),
    ).toEqual([]);
  });

  test("two creates of one id at once: one row, one receipt, and the other refused", async () => {
    const owner = await person("owner");
    const outcomes = await Promise.all(
      ["first-key-0001", "second-key-0002"].map((value) =>
        store().create(add("connections", "raced", CONNECTION), value, owner),
      ),
    );
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "conflict",
      "done",
    ]);
    expect(
      await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, "raced")),
    ).toHaveLength(1);
    const made = (await receiptsOf("create_connection")).filter(
      (row) =>
        (row.result as { connection_id?: unknown }).connection_id === "raced",
    );
    expect(made).toHaveLength(1);
  });

  test("an admin or member may not write a connection or MCP server", async () => {
    for (const role of ["admin", "member"] as const) {
      const someone = await person(role);
      expect(
        await store().create(
          add("connections", `by-${role}`, CONNECTION),
          "v",
          someone,
        ),
      ).toEqual({ outcome: "actor_inactive" });
      expect(
        await store().create(
          add("mcp_servers", `by-${role}`, MCP),
          "v",
          someone,
        ),
      ).toEqual({ outcome: "actor_inactive" });
    }
  });

  test("an operator's reference is only disabled: no value, no workspaces change", async () => {
    const owner = await person("owner");
    await db.insert(mcpServers).values({
      id: "operator-docs",
      url: "https://mcp.example.invalid/op",
      credentialRef: "op_token",
      auth: { kind: "bearer", value_env: "MCP_TOKEN" },
      credentialSource: "external",
      workspaces: ["acme"],
      origin: "import",
    });
    expect(
      await store().setValue({ kind: "mcp", id: "operator-docs" }, "v", owner),
    ).toEqual({ outcome: "conflict", reason: "not_stored" });
    expect(
      await store().setMcpWorkspaces("operator-docs", ["other"], owner),
    ).toEqual({ outcome: "conflict", reason: "not_stored" });
    expect(
      (await store().disable({ kind: "mcp", id: "operator-docs" }, owner))
        .outcome,
    ).toBe("done");
    expect(
      await store().disable({ kind: "mcp", id: "operator-docs" }, owner),
    ).toEqual({ outcome: "conflict", reason: "disabled" });
    expect(
      await store().setValue({ kind: "mcp", id: "nowhere" }, "v", owner),
    ).toEqual({ outcome: "not_found" });
  });

  test("a stored MCP server's value turns, its workspaces change in place, and a disabled row leaves the registry", async () => {
    const owner = await person("owner");
    expect(
      (await store().create(add("mcp_servers", "docs", MCP), "first", owner))
        .outcome,
    ).toBe("done");
    expect(
      (await store().setValue({ kind: "mcp", id: "docs" }, "second", owner))
        .outcome,
    ).toBe("done");
    expect(
      (await settings().read({ openStored: true })).stored.get("mcp:docs"),
    ).toBe("second");
    const [turned] = await receiptsOf("set_settings_credential");
    expect(turned?.result).toEqual({ mcp_server_id: "docs", last4: "cond" });

    expect(
      (await store().setMcpWorkspaces("docs", ["acme", "labs"], owner)).outcome,
    ).toBe("done");
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "docs"));
    expect(row?.workspaces).toEqual(["acme", "labs"]);

    expect(
      (await store().disable({ kind: "mcp", id: "docs" }, owner)).outcome,
    ).toBe("done");
    const read = await settings().read();
    expect(read.mcpServers.map((item) => item.id)).not.toContain("docs");
    expect(
      await store().setValue({ kind: "mcp", id: "docs" }, "third", owner),
    ).toEqual({ outcome: "conflict", reason: "disabled" });
    // Re-made under the same id: never.
    expect(
      await store().create(add("mcp_servers", "docs", MCP), "again", owner),
    ).toEqual({ outcome: "conflict", reason: "already_exists" });
  });
});

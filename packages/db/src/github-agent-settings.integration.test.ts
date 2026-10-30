import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretKey } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createPostgresGitHubAppStore } from "./github-apps.ts";
import * as schema from "./schema.ts";
import { writeSecretInTx } from "./secret-values.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MIGRATIONS = join(import.meta.dir, "../migrations");

type Journal = { entries: Array<{ tag: string }> };

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "github-agent-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal: Journal = JSON.parse(
    await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`no migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  return folder;
}

// The expand step of the GitHub agent settings (github-agent.md §5): what a
// database from before it holds reads the same, and what the image from
// before it writes still lands.
integration("GitHub agent settings, expand", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "github_agent_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough("0193_turn_slack_message");
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  test("a registered App becomes the author App, and every agent keeps GitHub on", async () => {
    await migrate(db, { migrationsFolder: before });
    const workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const appRow = randomUUID();
    const insertApp = (id: string, appId: number) =>
      pool.query(
        `INSERT INTO github_apps (id, workspace_id, app_id, slug, name, html_url, api_base)
         VALUES ($1, $2, $3, 'werft', 'Werft', 'https://github.com/apps/werft', 'https://api.github.com')`,
        [id, workspaceId, appId],
      );
    await insertApp(appRow, 5513262);
    const agentId = randomUUID();
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'a', 'a')",
      [agentId, workspaceId],
    );

    await migrate(db, { migrationsFolder: MIGRATIONS });

    expect(
      (
        await pool.query(
          "SELECT role, permissions, permissions_checked_at FROM github_apps",
        )
      ).rows,
    ).toEqual([
      { role: "author", permissions: null, permissions_checked_at: null },
    ]);
    expect(
      (await pool.query("SELECT github_enabled FROM agents")).rows,
    ).toEqual([{ github_enabled: true }]);

    const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString()
      .trim();
    await writeSecretInTx(
      db,
      key,
      {
        workspaceId,
        owner: { kind: "github_app", id: appRow },
        purpose: "github_app_private_key",
      },
      pem,
      null,
    );
    const store = createPostgresGitHubAppStore(db, key);
    expect(await store.find(workspaceId, "author")).toMatchObject({
      id: appRow,
      appId: 5513262,
    });
    expect(await store.find(workspaceId, "reviewer")).toBeNull();
    expect((await store.credentials("author")).map(({ id }) => id)).toEqual([
      appRow,
    ]);
    expect(await store.credentials("reviewer")).toEqual([]);

    // The image from before writes rows without a role or a switch: they
    // land as the author App and an agent with GitHub on, and a second
    // author App is still refused as one per workspace was.
    await expect(insertApp(randomUUID(), 7)).rejects.toThrow(
      "github_apps_workspace_role_uniq",
    );
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'b', 'b')",
      [randomUUID(), workspaceId],
    );
    expect(
      (
        await pool.query(
          "SELECT slug, github_enabled FROM agents ORDER BY slug",
        )
      ).rows,
    ).toEqual([
      { slug: "a", github_enabled: true },
      { slug: "b", github_enabled: true },
    ]);
  });

  test("a person may hold a GitHub link beside a Slack one; other providers stay refused", async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const workspaceId = randomUUID();
    const userId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'p')",
      [userId, `${userId}@example.test`],
    );
    const link = (provider: string, via: string, tenant: string) =>
      pool.query(
        `INSERT INTO linked_accounts (id, workspace_id, user_id, provider,
           external_tenant, external_user_id, verified_via, verified_at)
         VALUES ($1, $2, $3, $4, $5, '583231', $6, now())`,
        [randomUUID(), workspaceId, userId, provider, tenant, via],
      );
    await link("slack", "slack_oidc", "T01");
    await link("github", "github_oauth", "github.com");
    await expect(link("gitlab", "oauth", "gitlab.com")).rejects.toThrow(
      "linked_accounts_provider_check",
    );
    // One live GitHub account per person, as for a Slack team.
    await expect(link("github", "github_oauth", "github.com")).rejects.toThrow(
      "linked_accounts_",
    );
  });

  test("workspace GitHub settings hold one row per workspace", async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    const workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const ceiling = JSON.stringify({
      workflows: false,
      actions: true,
      checks: false,
      issues: false,
      review: false,
    });
    await pool.query(
      "INSERT INTO github_workspace_settings (workspace_id, ceiling) VALUES ($1, $2)",
      [workspaceId, ceiling],
    );
    expect(
      (
        await pool.query(
          "SELECT ceiling, oauth_client_secret_set, revision FROM github_workspace_settings",
        )
      ).rows,
    ).toEqual([
      {
        ceiling: JSON.parse(ceiling),
        oauth_client_secret_set: false,
        revision: 1,
      },
    ]);
    await expect(
      pool.query(
        "INSERT INTO github_workspace_settings (workspace_id, ceiling) VALUES ($1, $2)",
        [workspaceId, ceiling],
      ),
    ).rejects.toThrow("github_workspace_settings_pkey");
  });
});

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
import {
  catalogProfileConfigSchema,
  definitionFingerprint,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresInstallationProfileStore } from "./installation-profiles.ts";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import { createPostgresWorkspaceProfileStore } from "./workspace-profiles.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MIGRATIONS = join(import.meta.dir, "../migrations");

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "profile-deny-migrations-"));
  await mkdir(join(folder, "meta"));
  const journal: { entries: Array<{ tag: string }> } = JSON.parse(
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

const DEFINITION = catalogProfileConfigSchema.parse({
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet",
  tools: ["Read", "Edit"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
  },
});
const FINGERPRINT = definitionFingerprint("coding", DEFINITION);

integration("profile deny migration over an installation's rows", () => {
  test("rows from before read and hash as they did, and deny stays out of what runs", async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "profile_deny_expand_it",
    });
    const pool = new Pool({ connectionString: database.url, max: 2 });
    const db = drizzle(pool, { schema });
    const before = await migrationsThrough("0226_slack_thread_status");
    const workspace = randomUUID();
    const user = randomUUID();
    try {
      await migrate(db, { migrationsFolder: before });
      await pool.query(
        `INSERT INTO installation_profiles (id, version, origin, definition, permission_mode, fingerprint, repository_ids)
         VALUES ('coding', 1, 'catalog', $1, 'default', $2, '[]')`,
        [JSON.stringify(DEFINITION), FINGERPRINT],
      );
      await pool.query(
        `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'Acme')`,
        [workspace],
      );
      await pool.query(
        `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, 'a@example.com', 'x', 'A')`,
        [user],
      );
      await pool.query(
        `INSERT INTO workspace_profiles (id, workspace_id, name, version, base_profile_id, base_fingerprint, base_runtime_version, base_billing, base_repository_mode, model, models, tools, permission_mode, created_by)
         VALUES ('ws_acme_strict_v1', $1, 'strict', 1, 'coding', $2, '0.3.270', 'metered', 'none', 'claude-sonnet', '["claude-sonnet"]', '["Read"]', 'default', $3)`,
        [workspace, FINGERPRINT, user],
      );

      await migrate(db, { migrationsFolder: MIGRATIONS });

      for (const table of ["installation_profiles", "workspace_profiles"]) {
        expect(
          (await pool.query(`SELECT deny, tool_catalog_id FROM ${table}`)).rows,
        ).toEqual([{ deny: null, tool_catalog_id: null }]);
      }
      const ceilings = createPostgresInstallationProfileStore(db);
      const versions = createPostgresWorkspaceProfileStore(db);
      const [ceiling] = await ceilings.listAll();
      expect(ceiling?.fingerprint).toBe(FINGERPRINT);
      expect(
        definitionFingerprint(
          "coding",
          catalogProfileConfigSchema.parse(ceiling?.definition),
        ),
      ).toBe(FINGERPRINT);
      const [version] = await versions.listAll();
      expect(version).toMatchObject({
        base_fingerprint: FINGERPRINT,
        tools: ["Read"],
      });

      const read = {
        ceilings: await ceilings.listAll(),
        versions: await versions.listAll(),
      };
      for (const table of ["installation_profiles", "workspace_profiles"]) {
        await pool.query(
          `UPDATE ${table} SET deny = '["Bash"]', tool_catalog_id = 'claude_agent_sdk@0.3.270'`,
        );
      }
      // Read beside what runs, never in it: the rest of each row is as before.
      const columns = {
        deny: ["Bash"],
        tool_catalog_id: "claude_agent_sdk@0.3.270",
      };
      expect({
        ceilings: await ceilings.listAll(),
        versions: await versions.listAll(),
      }).toEqual({
        ceilings: read.ceilings.map((row) => ({ ...row, ...columns })),
        versions: read.versions.map((row) => ({ ...row, ...columns })),
      });

      for (const table of ["installation_profiles", "workspace_profiles"]) {
        for (const set of [
          `deny = '["Bash"]', tool_catalog_id = NULL`,
          `deny = '{"Bash": true}'`,
        ]) {
          let refused = "accepted";
          await pool
            .query(`UPDATE ${table} SET ${set}`)
            .catch((error: Error) => {
              refused = error.message;
            });
          expect(refused).toContain(`${table}_deny_check`);
        }
      }
    } finally {
      await pool.end();
      await database.drop();
      await rm(before, { recursive: true, force: true });
    }
  }, 60_000);
});

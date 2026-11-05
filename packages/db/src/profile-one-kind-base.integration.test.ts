import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@werft-ai/observability";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { Pool } from "pg";
import { migrateDatabase } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";

const integrationTest = testDatabaseUrl() ? test : test.skip;

// The packaged folder cut just before 0233_profile_one_kind_base.
function folderBefore(): string {
  const folder = mkdtempSync(join(tmpdir(), "profile-one-kind-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_profile_one_kind_base"),
  );
  if (at < 0) throw new Error("profile_one_kind_base is not in the journal");
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

integrationTest(
  "the base migration applies over rows that exist and changes none of them",
  async () => {
    const database = await createTempDatabase({
      migrate: false,
      prefix: "profile_one_kind",
    });
    const before = folderBefore();
    const pool = new Pool({ connectionString: database.url, max: 1 });
    try {
      const logger = createLogger();
      await migrateDatabase(database.url, {
        logger,
        migrationsFolder: before,
      });
      const workspace = randomUUID();
      const agent = randomUUID();
      await pool.query(
        `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'Acme')`,
        [workspace],
      );
      await pool.query(
        `INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'a', 'A')`,
        [agent, workspace],
      );
      const definition = JSON.stringify({ permission_mode: "default" });
      await pool.query(
        `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_ids)
         VALUES ('coding-v1', NULL, 1, 'catalog', $1::jsonb, 'default', 'fp', '["repo-a"]'::jsonb),
                ('op_ops_v1', 'op_ops_v1', 1, 'console', $1::jsonb, 'default', 'fp', '[]'::jsonb)`,
        [definition],
      );
      const profilesBefore = await pool.query(
        `SELECT * FROM installation_profiles ORDER BY id`,
      );

      expect(await migrateDatabase(database.url, { logger })).toMatchObject({
        applied: 1,
      });

      const profilesAfter = await pool.query(
        `SELECT * FROM installation_profiles ORDER BY id`,
      );
      for (const [index, row] of profilesAfter.rows.entries()) {
        expect(row).toMatchObject(profilesBefore.rows[index]);
        expect(row).toMatchObject({
          derived_from: null,
          workspace_id: null,
          display_name: null,
          migrated_from: null,
        });
      }
      expect(
        (await pool.query(`SELECT * FROM agents WHERE id = $1`, [agent]))
          .rows[0],
      ).toMatchObject({
        profile_tracking: "follow",
        behavior_revision: 0,
        model_source: "fixed",
        draft_version_id: null,
      });
      // A row that names no repository is accepted, and only that row.
      await pool.query(
        `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_scope, github_app_repositories)
         VALUES ('op_none_v1', 'op_none_v1', 1, 'console', $1::jsonb, 'default', 'fp', NULL, NULL)`,
        [definition],
      );
      await expect(
        pool.query(
          `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint)
           VALUES ('op_bad_v1', 'op_bad_v1', 1, 'console', $1::jsonb, 'default', 'fp')`,
          [definition],
        ),
      ).rejects.toThrow(/installation_profiles_repository_ids_check/);
    } finally {
      await pool.end();
      rmSync(before, { recursive: true, force: true });
      await database.drop();
    }
  },
  60_000,
);

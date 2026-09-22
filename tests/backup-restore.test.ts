import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The refusal paths of scripts/restore.sh, exercised without Docker: the
 * schema gate compares a backup's applied migration list (as the drizzle
 * journal recorded it) with this checkout's migration files, and a bundle
 * whose checksums do not match its SHA256SUMS is refused before that. The
 * compose round trip itself is the E2E recorded on the PR.
 */

const repoRoot = join(import.meta.dir, "..");
const lib = join(repoRoot, "scripts/lib/backup-lib.sh");

type Journal = { entries: { tag: string; when: number }[] };

async function checkoutMigrations() {
  const journal = JSON.parse(
    await readFile(
      join(repoRoot, "packages/db/migrations/meta/_journal.json"),
      "utf8",
    ),
  ) as Journal;
  return Promise.all(
    journal.entries.map(async (entry) => ({
      hash: createHash("sha256")
        .update(
          await readFile(
            join(repoRoot, "packages/db/migrations", `${entry.tag}.sql`),
          ),
        )
        .digest("hex"),
      when: String(entry.when),
      tag: entry.tag,
    })),
  );
}

async function bash(script: string, cwd: string) {
  const handle = Bun.spawn(["bash", "-c", script], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
    new Response(handle.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function withManifest(
  applied: { hash: string; when: string }[],
  run: (dir: string, manifest: string) => Promise<void>,
  version = 1,
) {
  const dir = await mkdtemp(join(tmpdir(), "backup-restore-"));
  try {
    const manifest = join(dir, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version,
        schema: { head_tag: "fixture", applied },
        objects: { bucket: "claude-sessions", count: 0 },
        repos: { bundled: [], empty: [] },
        source: { project: "fixture" },
      }),
    );
    await run(dir, manifest);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

const schemaCheck = (manifest: string) =>
  bash(`source "${lib}"; schema_check "${manifest}"`, repoRoot);

describe("restore schema gate", () => {
  test("expected_migrations lists the checkout's journal with drizzle's hashes", async () => {
    const expected = await checkoutMigrations();
    const result = await bash(`source "${lib}"; expected_migrations`, repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(
      expected.map((entry) => `${entry.hash} ${entry.when} ${entry.tag}`),
    );
  });

  test("accepts a backup whose applied list is exactly this checkout's", async () => {
    await withManifest(await checkoutMigrations(), async (_dir, manifest) => {
      const result = await schemaCheck(manifest);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("backup matches checkout head");
    });
  });

  test("refuses a backup with one migration's hash changed", async () => {
    const applied = await checkoutMigrations();
    const last = applied.at(-1);
    if (!last) throw new Error("no migrations");
    applied[applied.length - 1] = { ...last, hash: "0".repeat(64) };
    await withManifest(applied, async (_dir, manifest) => {
      const result = await schemaCheck(manifest);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("differ from this checkout");
    });
  });

  test("refuses an older backup missing the newest migration", async () => {
    const applied = (await checkoutMigrations()).slice(0, -1);
    await withManifest(applied, async (_dir, manifest) => {
      expect((await schemaCheck(manifest)).exitCode).toBe(3);
    });
  });

  test("refuses a newer backup carrying a migration this checkout lacks", async () => {
    const applied = await checkoutMigrations();
    applied.push({ hash: "f".repeat(64), when: "1999999999999", tag: "x" });
    await withManifest(applied, async (_dir, manifest) => {
      expect((await schemaCheck(manifest)).exitCode).toBe(3);
    });
  });

  test("refuses a manifest of another format version", async () => {
    await withManifest(
      await checkoutMigrations(),
      async (_dir, manifest) => {
        expect((await schemaCheck(manifest)).exitCode).toBe(3);
      },
      2,
    );
  });
});

describe("restore.sh preflight", () => {
  test("refuses a bundle whose files no longer match SHA256SUMS", async () => {
    await withManifest(await checkoutMigrations(), async (dir) => {
      await writeFile(join(dir, "db.sql"), "-- dump\n");
      const wrote = await bash(
        `source "${lib}"; write_checksums "${dir}" && verify_checksums "${dir}"`,
        repoRoot,
      );
      expect(wrote.exitCode).toBe(0);
      await writeFile(join(dir, "db.sql"), "-- edited\n");
      const result = await bash(
        `scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SHA256SUMS mismatch");
    });
  });

  test("checks the schema before touching docker", async () => {
    const applied = (await checkoutMigrations()).slice(0, -1);
    await withManifest(applied, async (dir) => {
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      const result = await bash(
        `PATH=/nonexistent:$PATH scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(3);
    });
  });

  test("rejects a project name compose could not scope volumes by", async () => {
    await withManifest(await checkoutMigrations(), async (dir) => {
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      const result = await bash(
        `scripts/restore.sh "${dir}" --into "Bad Name" --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project name must match");
    });
  });
});

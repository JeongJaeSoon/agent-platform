import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
  type WorkspaceCapture,
} from "../apps/worker/src/workspace-capture.ts";

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

describe("restored gitea address check", () => {
  const appIni = (server: string) =>
    [
      "APP_NAME = Gitea",
      "",
      "[server]",
      server,
      "HTTP_PORT = 3000",
      "SSH_LISTEN_PORT = 22",
      "",
      "[security]",
      "INSTALL_LOCK = true",
      "",
    ].join("\n");

  const addressIs = async (ini: string) => {
    const dir = await mkdtemp(join(tmpdir(), "backup-restore-ini-"));
    try {
      await writeFile(join(dir, "app.ini"), ini);
      return await bash(
        `source "${lib}"; gitea_address_is 25434 25435 < "${join(dir, "app.ini")}"`,
        repoRoot,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  };

  test("accepts the restore address as environment-to-ini writes it", async () => {
    const result = await addressIs(
      appIni(
        [
          "DOMAIN = 127.0.0.1",
          "SSH_DOMAIN = 127.0.0.1",
          "ROOT_URL = http://127.0.0.1:25434/",
          "SSH_PORT = 25435",
        ].join("\n"),
      ),
    );
    expect(result.exitCode).toBe(0);
  });

  test("refuses the source's address left in place", async () => {
    const result = await addressIs(
      appIni(
        [
          "DOMAIN = example.test",
          "SSH_DOMAIN = example.test",
          "ROOT_URL = http://example.test:3001/",
          "SSH_PORT = 2222",
        ].join("\n"),
      ),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "does not say ROOT_URL=http://127.0.0.1:25434/",
    );
  });

  test("does not take the right values from another section or a comment", async () => {
    const result = await addressIs(
      [
        "[server]",
        "; ROOT_URL = http://127.0.0.1:25434/",
        "DOMAIN = 127.0.0.1",
        "SSH_DOMAIN = 127.0.0.1",
        "SSH_PORT = 25435",
        "[server.extra]",
        "ROOT_URL = http://127.0.0.1:25434/",
        "",
      ].join("\n"),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not say ROOT_URL=");
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

  test("refuses a bundle with a file SHA256SUMS does not list", async () => {
    await withManifest(await checkoutMigrations(), async (dir) => {
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      await writeFile(join(dir, "repos-extra.bundle"), "not listed\n");
      const result = await bash(
        `scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("files present differ from SHA256SUMS");
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

describe("verify-restore bundle chain", () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-chain-"));
    root = join(dir, "workspace");
    await mkdir(root);
    await git("init", "--quiet", "--initial-branch=main");
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  // No global or system config: hooks a developer's git runs on commit have
  // no business in a throwaway workspace.
  async function git(...args: string[]) {
    const handle = Bun.spawn(["git", ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  }

  async function commit(path: string, body: string) {
    await writeFile(join(root, path), body);
    await git("add", "--all");
    await git("commit", "--quiet", "-m", path);
  }

  /** The worker's own capture, on top of `earlier` the way a chain grows. */
  async function capture(
    ...earlier: WorkspaceCapture[]
  ): Promise<WorkspaceCapture> {
    const result = await captureWorkspace({
      root,
      bundlePath: join(dir, `${randomUUID()}.bundle`),
      signal: new AbortController().signal,
      ...(earlier.length === 0
        ? {}
        : {
            base: {
              maxBytes: DEFAULT_WORKSPACE_CAPTURE_LIMITS.maxBundleBytes,
              tips: earlier.flatMap(({ bundle }) => bundle.tips),
            },
          }),
    });
    if (result.status !== "captured") throw new Error(result.reason);
    return result.capture;
  }

  async function unbundle(commit: string, ...chain: WorkspaceCapture[]) {
    const repository = join(dir, `verify-${randomUUID()}.git`);
    expect(
      (await bash(`git init --quiet --bare "${repository}"`, dir)).exitCode,
    ).toBe(0);
    return bash(
      `source "${lib}"; unbundle_chain "${repository}" "${commit}" ${chain.map(({ bundle }) => `"${bundle.path}"`).join(" ")}`,
      repoRoot,
    );
  }

  test("an incremental bundle alone does not verify in an empty repository (94S-372)", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    await commit("a.txt", "a, then b\n");
    const second = await capture(first);

    expect(second.bundle.incremental).toBe(true);
    const result = await unbundle(second.gitCommit, second);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "bundle 1 of 1: git bundle verify rejected it",
    );
  });

  test("the chain applied base first verifies, and the last bundle's worktree ref is the checkpoint's commit", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    await commit("a.txt", "a, then b\n");
    await writeFile(join(root, "a.txt"), "uncommitted\n");
    const second = await capture(first);

    expect(second.bundle.incremental).toBe(true);
    const result = await unbundle(second.gitCommit, first, second);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  // 94S-135's fault-backup-restore-resume: both turns wrote only an
  // untracked file, which travels outside the bundle. So the second capture
  // changed nothing git tracks, and carries its refs as annotated tags over
  // commits the base has: the last bundle lists the tag, never the commit. A
  // restore peels refs/checkpoint/worktree; the verifier has to as well.
  test("verifies a capture that changed nothing tracked, whose worktree ref is a tag over a commit of its base (94S-374)", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    const second = await capture(first);

    expect(second.bundle.incremental).toBe(true);
    expect(second.gitCommit).toBe(first.gitCommit);
    const result = await unbundle(second.gitCommit, first, second);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("refuses the chain out of order, or a commit other than the last bundle's worktree", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    await commit("a.txt", "a, then b\n");
    const second = await capture(first);

    const reversed = await unbundle(second.gitCommit, second, first);
    expect(reversed.exitCode).toBe(1);
    expect(reversed.stdout).toContain("bundle 1 of 2");
    const stale = await unbundle(first.gitCommit, first, second);
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout).toBe(
      `the last bundle's refs/checkpoint/worktree is ${second.gitCommit}, not ${first.gitCommit}\n`,
    );
  });
});

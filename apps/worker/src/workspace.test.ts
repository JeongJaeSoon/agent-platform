import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceDescriptor } from "@agent-platform/contracts";

import { COMMITTED_CLAUDE_MD_MAX_BYTES, GitWorkspace } from "./workspace.ts";

let scratch: string;
let origin: string;
let root: string;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function descriptor(url = origin, branch = "main"): WorkspaceDescriptor {
  return { repository: { id: "sample-app", url, branch } };
}

function prepare(workspace: WorkspaceDescriptor, signal?: AbortSignal) {
  return new GitWorkspace(root).prepare({
    descriptor: workspace,
    restore: null,
    signal: signal ?? new AbortController().signal,
  });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "94s-122-ws-"));
  origin = join(scratch, "origin.git");
  root = join(scratch, "workspace");
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], scratch);
  const seed = join(scratch, "seed");
  git(["clone", "--quiet", origin, seed], scratch);
  await writeFile(join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", "origin", "HEAD:main"], seed);
  await mkdir(root);
});

afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

/**
 * Git's dumb HTTP protocol is plain files, so a static server behind Basic
 * auth is enough to make a credential load-bearing.
 */
function serveOrigin(expected: string | null) {
  git(["update-server-info"], origin);
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const auth = request.headers.get("authorization");
      seen.push(auth ?? "anonymous");
      if (expected !== null && auth !== expected) {
        return new Response("who?", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="git"' },
        });
      }
      const path = new URL(request.url).pathname.replace(/^\/repo\.git/, "");
      const file = Bun.file(join(origin, path));
      return (await file.exists())
        ? new Response(file)
        : new Response("missing", { status: 404 });
    },
  });
  return { seen, server };
}

describe("GitWorkspace", () => {
  test("clones the session's branch into an empty mount", async () => {
    expect(await prepare(descriptor())).toBe("clone");
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], root)).toBe("main");
    expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
  });

  test("reuses a sound checkout of the same origin and keeps its work", async () => {
    await prepare(descriptor());
    await writeFile(join(root, "notes.txt"), "left by the last attempt\n");

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(join(root, "notes.txt")).text()).toBe(
      "left by the last attempt\n",
    );
  });

  test("starts over from this session's shallow checkout when it holds nothing", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);

    expect(await prepare(descriptor(`file://${origin}`))).toBe("recreate");
    expect(git(["rev-parse", "--is-shallow-repository"], root)).toBe("false");
  });

  test("refuses to delete an unsound checkout that holds work", async () => {
    git(["clone", "--quiet", "--depth=1", `file://${origin}`, root], scratch);
    await writeFile(join(root, "draft.txt"), "only here\n");

    await expect(prepare(descriptor(`file://${origin}`))).rejects.toThrow(
      "holds work that exists nowhere else",
    );
    expect(await Bun.file(join(root, "draft.txt")).text()).toBe("only here\n");
  });

  test("refuses files that are not a checkout, and leaves them alone", async () => {
    await writeFile(join(root, "stray.txt"), "?\n");

    await expect(prepare(descriptor())).rejects.toThrow("not a git checkout");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });

  test("refuses a checkout of another repository", async () => {
    await prepare(descriptor());

    await expect(
      prepare(descriptor("https://git.example.test/other.git")),
    ).rejects.toThrow("another repository");
  });

  test("leaves a committed checkpoint to the restorer", async () => {
    await writeFile(join(root, "stray.txt"), "?\n");

    expect(
      await new GitWorkspace(root).prepare({
        descriptor: descriptor(),
        restore: {
          revision: 3,
          manifest_ref: "sessions/x/manifest-3.json",
          manifest_sha256: "a".repeat(64),
        },
        signal: new AbortController().signal,
      }),
    ).toBe("restore");
    expect(await readdir(root)).toEqual(["stray.txt"]);
  });

  test("clones with the URL's credential but never stores it where the engine can read it", async () => {
    const { seen, server } = serveOrigin(
      `Basic ${btoa("someone:s3cr3t/pass")}`,
    );
    try {
      const url = `http://someone:s3cr3t%2Fpass@127.0.0.1:${server.port}/repo.git`;

      expect(await prepare(descriptor(url))).toBe("clone");
      expect(await Bun.file(join(root, "README.md")).text()).toBe("seed\n");
      const stored = await Bun.file(join(root, ".git", "config")).text();
      expect(stored).not.toContain("s3cr3t");
      expect(stored).not.toContain("someone");
      expect(git(["config", "--get", "remote.origin.url"], root)).toBe(
        `http://127.0.0.1:${server.port}/repo.git`,
      );
      expect(seen).toContain(`Basic ${btoa("someone:s3cr3t/pass")}`);

      // A later attempt reuses it, fetching with the same credential.
      expect(await prepare(descriptor(url))).toBe("reuse");
    } finally {
      server.stop(true);
    }
  });

  test("runs none of the hooks a previous engine planted in a reused checkout", async () => {
    await prepare(descriptor());
    const marker = join(scratch, "hook-ran");
    const hooks = join(scratch, "planted-hooks");
    await mkdir(hooks);
    for (const dir of [hooks, join(root, ".git", "hooks")]) {
      const hook = join(dir, "post-checkout");
      await writeFile(hook, `#!/bin/sh\nenv > "${marker}"\n`);
      await chmod(hook, 0o755);
    }
    git(["config", "core.hooksPath", hooks], root);

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("fetches a reuse past whatever the checkout's config rewrites origin to", async () => {
    const real = serveOrigin(`Basic ${btoa("someone:s3cr3t")}`);
    const lure = serveOrigin(null);
    try {
      const url = `http://someone:s3cr3t@127.0.0.1:${real.server.port}/repo.git`;
      await prepare(descriptor(url));
      // What a previous engine could leave behind: every fetch of the real
      // origin quietly goes to another host.
      git(
        [
          "config",
          `url.http://127.0.0.1:${lure.server.port}/.insteadOf`,
          `http://127.0.0.1:${real.server.port}/`,
        ],
        root,
      );

      expect(await prepare(descriptor(url))).toBe("reuse");
      expect(lure.seen).toEqual([]);
    } finally {
      real.server.stop(true);
      lure.server.stop(true);
    }
  });

  test("runs no transport command the checkout's config names", async () => {
    const { server } = serveOrigin(`Basic ${btoa("someone:s3cr3t")}`);
    try {
      const url = `http://someone:s3cr3t@127.0.0.1:${server.port}/repo.git`;
      await prepare(descriptor(url));
      const marker = join(scratch, "transport-ran");
      const command = join(scratch, "steal");
      await writeFile(command, `#!/bin/sh\nenv > "${marker}"\nexit 1\n`);
      await chmod(command, 0o755);
      git(["config", "core.sshCommand", command], root);
      git(["config", "core.askPass", command], root);
      git(
        [
          "config",
          "url.ssh://git@127.0.0.1/repo.git.insteadOf",
          `http://127.0.0.1:${server.port}/repo.git`,
        ],
        root,
      );

      expect(await prepare(descriptor(url))).toBe("reuse");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("runs no filter driver the checkout's config defines", async () => {
    await prepare(descriptor());
    const marker = join(scratch, "filter-ran");
    const filter = join(scratch, "wedge");
    await writeFile(filter, `#!/bin/sh\ntouch "${marker}"\nsleep 30\n`);
    await chmod(filter, 0o755);
    git(["config", "filter.wedge.clean", filter], root);
    git(["config", "filter.wedge.smudge", filter], root);
    git(["config", "filter.wedge.required", "true"], root);
    await writeFile(
      join(root, ".git", "info", "attributes"),
      "* filter=wedge\n",
    );
    // Dirty to git's stat check, so status has to look at the content.
    await writeFile(join(root, "README.md"), "seed\n");
    const touched = new Date(Date.now() + 5_000);
    await utimes(join(root, "README.md"), touched, touched);

    expect(await prepare(descriptor())).toBe("reuse");
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 20_000);

  test("keeps an unsound checkout whose only work is an ignored file", async () => {
    await prepare(descriptor());
    await writeFile(join(root, ".gitignore"), ".env\n");
    git(["add", ".gitignore"], root);
    git(["commit", "--quiet", "-m", "ignore"], root);
    git(["push", "--quiet", "origin", "HEAD:main"], root);
    await writeFile(join(root, ".env"), "only copy\n");
    await writeFile(
      join(root, ".git", "shallow"),
      `${git(["rev-parse", "HEAD"], root)}\n`,
    );

    await expect(prepare(descriptor())).rejects.toThrow("refused");
    expect(await Bun.file(join(root, ".env")).text()).toBe("only copy\n");
  });

  test("keeps an unsound checkout whose only work is a detached commit", async () => {
    await prepare(descriptor());
    git(["checkout", "--quiet", "--detach"], root);
    await writeFile(join(root, "WORK.md"), "only here\n");
    git(["add", "WORK.md"], root);
    git(["commit", "--quiet", "-m", "detached"], root);
    await writeFile(
      join(root, ".git", "shallow"),
      `${git(["rev-parse", "HEAD~1"], root)}\n`,
    );

    await expect(prepare(descriptor())).rejects.toThrow("refused");
    expect(await Bun.file(join(root, "WORK.md")).text()).toBe("only here\n");
  });

  test("brings the origin's new commits into a reused checkout", async () => {
    await prepare(descriptor());
    const seed = join(scratch, "seed");
    await writeFile(join(seed, "NEXT.md"), "next\n");
    git(["add", "NEXT.md"], seed);
    git(["commit", "--quiet", "-m", "next"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    expect(await prepare(descriptor())).toBe("reuse");
    expect(git(["rev-parse", "origin/main"], root)).toBe(
      git(["rev-parse", "HEAD"], seed),
    );
  });

  test("never puts the repository credential in a failure", async () => {
    // Nothing listens on the discard port, so the clone fails at once.
    const url = "http://someone:hunter2@127.0.0.1:9/private.git";

    const failure = await prepare(descriptor(url)).catch(
      (error: Error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("git clone failed");
    expect((failure as Error).message).not.toContain("hunter2");
  });

  test("stops at once when the worker is told to stop", async () => {
    const stop = new AbortController();
    stop.abort();

    await expect(prepare(descriptor(), stop.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});

describe("GitWorkspace.committedClaudeMd", () => {
  /** Commits to origin's main, as the repository's authors would. */
  async function publish(
    files: Record<string, string>,
    links: Record<string, string> = {},
  ): Promise<void> {
    const seed = join(scratch, "seed");
    git(["pull", "--quiet", "origin", "main"], seed);
    // Whatever stood at a path before — a directory, a link — is replaced.
    for (const [path, text] of Object.entries(files)) {
      await rm(join(seed, path), { force: true, recursive: true });
      await mkdir(join(seed, path, ".."), { recursive: true });
      await writeFile(join(seed, path), text);
    }
    for (const [path, target] of Object.entries(links)) {
      await rm(join(seed, path), { force: true, recursive: true });
      await symlink(target, join(seed, path));
    }
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "publish"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
  }

  async function prepared(): Promise<GitWorkspace> {
    const workspace = new GitWorkspace(root);
    await workspace.prepare({
      descriptor: descriptor(),
      restore: null,
      signal: new AbortController().signal,
    });
    return workspace;
  }

  test("reads the file the branch has committed, and none when it has none", async () => {
    expect((await prepared()).committedClaudeMd()).toBeNull();
    await rm(root, { force: true, recursive: true });
    await mkdir(root);
    await publish({ "CLAUDE.md": "Run bun test.\n" });

    expect((await prepared()).committedClaudeMd()).toBe("Run bun test.\n");
  });

  test("a retry reads the branch, not what the last attempt left in the checkout", async () => {
    await publish({ "CLAUDE.md": "committed rules\n" });
    await prepared();
    // What an engine could do before dying: edit the file, commit on the
    // branch, and leave an uncommitted edit on top.
    await writeFile(join(root, "CLAUDE.md"), "agent rules, committed\n");
    git(["commit", "--quiet", "-am", "agent"], root);
    await writeFile(join(root, "CLAUDE.md"), "agent rules, uncommitted\n");

    const retry = await prepared();

    expect(await Bun.file(join(root, "CLAUDE.md")).text()).toBe(
      "agent rules, uncommitted\n",
    );
    expect(retry.committedClaudeMd()).toBe("committed rules\n");
  });

  test("a retry sees what the branch published since", async () => {
    await publish({ "CLAUDE.md": "first\n" });
    await prepared();
    await publish({ "CLAUDE.md": "second\n" });

    expect((await prepared()).committedClaudeMd()).toBe("second\n");
  });

  test("follows a committed link that stays in the tree", async () => {
    await publish(
      { "docs/AGENTS.md": "shared rules\n" },
      { "AGENTS.md": "docs/AGENTS.md", "CLAUDE.md": "AGENTS.md" },
    );

    expect((await prepared()).committedClaudeMd()).toBe("shared rules\n");
  });

  test("a committed link to nothing is no instructions", async () => {
    await publish({}, { "CLAUDE.md": "missing.md" });

    expect((await prepared()).committedClaudeMd()).toBeNull();
  });

  test("refuses a committed link that leaves the tree, whatever the checkout holds there", async () => {
    await writeFile(join(scratch, "outside.md"), "WORKER_SECRET=1\n");
    for (const target of ["../outside.md", join(scratch, "outside.md")]) {
      await publish({}, { "CLAUDE.md": target });
      const workspace = await prepared();
      expect(() => workspace.committedClaudeMd()).toThrow(
        "Repository CLAUDE.md refused: it links outside the repository",
      );
    }
  });

  test("refuses a directory, a link loop and a file past the cap — but only when asked", async () => {
    await publish({ "CLAUDE.md/inner.md": "x" });
    const directory = await prepared();
    expect(() => directory.committedClaudeMd()).toThrow("not a regular file");

    await publish({}, { "CLAUDE.md": "AGENTS.md", "AGENTS.md": "CLAUDE.md" });
    const loop = await prepared();
    expect(() => loop.committedClaudeMd()).toThrow("too many symlinks");

    await publish({
      "CLAUDE.md": "a".repeat(COMMITTED_CLAUDE_MD_MAX_BYTES + 1),
    });
    const large = await prepared();
    expect(() => large.committedClaudeMd()).toThrow(
      `larger than ${COMMITTED_CLAUDE_MD_MAX_BYTES} bytes`,
    );
  });

  test("a file exactly at the cap is whole", async () => {
    const whole = "b".repeat(COMMITTED_CLAUDE_MD_MAX_BYTES);
    await publish({ "CLAUDE.md": whole });

    expect((await prepared()).committedClaudeMd()).toBe(whole);
  });

  test("a restore fetched nothing, so a profile that wants the file is refused", async () => {
    await publish({ "CLAUDE.md": "committed rules\n" });
    const workspace = await prepared();
    expect(workspace.committedClaudeMd()).toBe("committed rules\n");

    await workspace.prepare({
      descriptor: descriptor(),
      restore: {
        revision: 3,
        manifest_ref: "sessions/x/manifest-3.json",
        manifest_sha256: "a".repeat(64),
      },
      signal: new AbortController().signal,
    });

    expect(() => workspace.committedClaudeMd()).toThrow(
      "no freshly fetched commit",
    );
  });
});

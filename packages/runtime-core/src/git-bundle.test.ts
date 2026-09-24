import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gitBundleOffers,
  gitBundleOffersFrom,
  readGitBundleHeader,
} from "./git-bundle.ts";

/**
 * The parser is only worth anything if it agrees with git, so the fixtures are
 * bundles git itself wrote rather than strings shaped like one.
 */

const workspaces: string[] = [];

afterAll(async () => {
  for (const directory of workspaces) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const handle = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
    new Response(handle.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}

/** A repository with `commits` commits on `main`, and every commit's sha. */
async function repository(commits: number) {
  const directory = await mkdtemp(join(tmpdir(), "bundle-"));
  workspaces.push(directory);
  await git(directory, "init", "--initial-branch=main", ".");
  const shas: string[] = [];
  for (let index = 0; index < commits; index += 1) {
    await writeFile(join(directory, "file.txt"), `revision ${index}\n`);
    await git(directory, "add", "file.txt");
    await git(directory, "commit", "-m", `commit ${index}`);
    shas.push((await git(directory, "rev-parse", "HEAD")).trim());
  }
  return { directory, shas };
}

/** `git bundle create` over `revisions`; options must precede the path. */
async function bundle(
  directory: string,
  revisions: string[],
  options: string[] = [],
): Promise<Uint8Array> {
  const path = join(
    directory,
    `bundle-${[...options, ...revisions].join("_").replaceAll("/", "-")}.bundle`,
  );
  await git(directory, "bundle", "create", ...options, path, ...revisions);
  return new Uint8Array(await readFile(path));
}

describe("readGitBundleHeader", () => {
  test("reads the refs out of a bundle git wrote", async () => {
    const { directory, shas } = await repository(2);
    const bytes = await bundle(directory, ["main"]);
    const header = readGitBundleHeader(bytes);

    expect(header).toEqual({
      capabilities: [],
      // Straight after the blank line, where the packfile starts.
      packOffset: bytes.indexOf(0x0a, bytes.indexOf(0x0a) + 1) + 2,
      prerequisites: [],
      refs: [{ name: "refs/heads/main", oid: shas[1] as string }],
      version: 2,
    });
  });

  test("reads a v3 bundle's capability lines", async () => {
    const { directory } = await repository(1);
    const header = readGitBundleHeader(
      await bundle(directory, ["main"], ["--version=3"]),
    );

    expect(header?.version).toBe(3);
    expect(header?.capabilities).toContain("object-format=sha1");
  });

  test("reads the prerequisites of an incremental bundle", async () => {
    const { directory, shas } = await repository(2);
    const header = readGitBundleHeader(
      await bundle(directory, ["main", `^${shas[0] as string}`]),
    );

    expect(header?.prerequisites).toEqual([shas[0] as string]);
    expect(header?.refs).toEqual([
      { name: "refs/heads/main", oid: shas[1] as string },
    ]);
  });

  test.each([
    ["empty bytes", ""],
    ["a header with no packfile", "# v2 git bundle\n\nnot-a-pack"],
    ["a text file that only looks like one", "# v1 git bundle\n\nPACK"],
    [
      "a ref line with no ref name",
      "# v2 git bundle\n" + "a".repeat(40) + "\n\nPACK",
    ],
    [
      "a capability line in a v2 bundle",
      "# v2 git bundle\n@object-format=sha1\n\nPACK",
    ],
  ])("refuses %s", (_label, text) => {
    expect(readGitBundleHeader(new TextEncoder().encode(text))).toBeUndefined();
  });

  test("refuses a bundle whose header never terminates", () => {
    // A single unterminated line longer than the scan limit: the reader gives
    // up rather than walking an arbitrarily large object.
    const runaway = `# v2 git bundle\n${"a".repeat(2 * 1024 * 1024)}`;
    expect(
      readGitBundleHeader(new TextEncoder().encode(runaway)),
    ).toBeUndefined();
  });
});

/**
 * The streamed reader refills one small buffer for every chunk, as the store
 * contract allows: a reader that kept a view instead of a copy would judge
 * whatever the last refill left behind.
 */
async function* refilled(bytes: Uint8Array, size: number) {
  const buffer = new Uint8Array(size);
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    const piece = bytes.subarray(offset, offset + size);
    buffer.set(piece);
    yield buffer.subarray(0, piece.byteLength);
  }
}

describe.each([
  [
    "whole",
    async (
      bytes: Uint8Array,
      commit: string | undefined,
      earlier?: ReadonlySet<string>,
    ) => gitBundleOffers(bytes, commit, earlier),
  ],
  [
    "streamed in 7-byte chunks",
    (
      bytes: Uint8Array,
      commit: string | undefined,
      earlier?: ReadonlySet<string>,
    ) => gitBundleOffersFrom(refilled(bytes, 7), commit, earlier),
  ],
  [
    "streamed a byte at a time",
    (
      bytes: Uint8Array,
      commit: string | undefined,
      earlier?: ReadonlySet<string>,
    ) => gitBundleOffersFrom(refilled(bytes, 1), commit, earlier),
  ],
])("gitBundleOffers, %s", (_label, offers) => {
  test("offers the ref whose tip is the commit", async () => {
    const { directory, shas } = await repository(2);

    expect(
      await offers(await bundle(directory, ["main"]), shas[1] as string),
    ).toEqual({
      // Two commits, their trees and their blobs.
      objects: 6,
      refs: ["refs/heads/main"],
      status: "offers",
      tips: [shas[1] as string],
    });
  });

  test("offers an incremental bundle whose prerequisites an earlier bundle offers as tips (94S-227)", async () => {
    const { directory, shas } = await repository(2);
    await git(directory, "branch", "base", shas[0] as string);
    const base = await bundle(directory, ["base"]);
    const incremental = await bundle(directory, [
      "main",
      `^${shas[0] as string}`,
    ]);

    const first = await offers(base, undefined);
    expect(first).toMatchObject({
      refs: ["refs/heads/base"],
      status: "offers",
      tips: [shas[0] as string],
    });
    if (first.status !== "offers") return;
    expect(
      await offers(incremental, shas[1] as string, new Set(first.tips)),
    ).toMatchObject({ refs: ["refs/heads/main"], status: "offers" });
    // Nothing new on top: the commit is the earlier bundle's tip.
    expect(
      await offers(incremental, shas[0] as string, new Set(first.tips)),
    ).toMatchObject({ status: "offers" });
    // A commit the chain has, but not as a tip: nothing vouches for it.
    expect(
      await offers(incremental, shas[1] as string, new Set(["a".repeat(40)])),
    ).toEqual({
      status: "unusable",
      reason:
        "git bundle needs 1 prerequisite commit(s) no earlier bundle offers as a ref tip",
    });
  });

  test("refuses a commit that is only inside the history", async () => {
    // The parent is in the packfile, but a fetch asks for refs, so nothing can
    // name it. A checkpoint pinning it would not restore.
    const { directory, shas } = await repository(2);

    expect(
      await offers(await bundle(directory, ["main"]), shas[0] as string),
    ).toMatchObject({ status: "unusable" });
  });

  test("refuses a commit the bundle has never heard of", async () => {
    const { directory } = await repository(1);

    expect(
      await offers(await bundle(directory, ["main"]), "b".repeat(40)),
    ).toEqual({
      status: "unusable",
      reason: `git bundle does not offer ${"b".repeat(40)} as a ref tip`,
    });
  });

  test("refuses an incremental bundle a fresh workspace cannot apply", async () => {
    const { directory, shas } = await repository(2);
    const incremental = await bundle(directory, [
      "main",
      `^${shas[0] as string}`,
    ]);

    expect(await offers(incremental, shas[1] as string)).toEqual({
      status: "unusable",
      reason:
        "git bundle needs 1 prerequisite commit(s) a fresh workspace does not have",
    });
  });

  test("refuses a bundle whose object format is not the one the manifest pins", async () => {
    const text = `# v3 git bundle\n@object-format=sha256\n${"c".repeat(64)} refs/heads/main\n\nPACK`;

    expect(
      await offers(new TextEncoder().encode(text), "c".repeat(64)),
    ).toEqual({
      status: "unusable",
      reason: "git bundle uses object format sha256",
    });
  });

  test("refuses a filtered bundle, whose pack promises objects instead of carrying them", async () => {
    const text = `# v3 git bundle\n@object-format=sha1\n@filter=blob:none\n${"c".repeat(40)} refs/heads/main\n\nPACK`;

    expect(
      await offers(new TextEncoder().encode(text), "c".repeat(40)),
    ).toEqual({
      status: "unusable",
      reason:
        "git bundle is filtered (filter=blob:none) and omits objects a restore needs",
    });
  });

  test("refuses a bundle whose packfile was truncated in transit", async () => {
    const { directory, shas } = await repository(2);
    const whole = await bundle(directory, ["main"]);

    expect(
      await offers(whole.subarray(0, whole.byteLength - 8), shas[1] as string),
    ).toEqual({
      status: "unusable",
      reason: "git bundle packfile does not match its own checksum",
    });
  });

  test("refuses a bundle whose packfile was altered under an intact header", async () => {
    // The header still names the commit and the length is unchanged, so only
    // git's own pack checksum tells the two apart.
    const { directory, shas } = await repository(2);
    const tampered = await bundle(directory, ["main"]);
    const target = tampered.byteLength - 40;
    tampered.set([(tampered[target] ?? 0) ^ 0xff], target);

    expect(await offers(tampered, shas[1] as string)).toEqual({
      status: "unusable",
      reason: "git bundle packfile does not match its own checksum",
    });
  });

  test("refuses a header-shaped file whose packfile is only the magic", async () => {
    // What a digest alone would wave through: bytes the worker hashed itself.
    const text = `# v2 git bundle\n${"a".repeat(40)} refs/heads/main\n\nPACK`;

    expect(
      await offers(new TextEncoder().encode(text), "a".repeat(40)),
    ).toEqual({
      status: "unusable",
      reason: "git bundle packfile is truncated",
    });
  });

  test("refuses a packfile whose version git never wrote", async () => {
    const header = new TextEncoder().encode(
      `# v2 git bundle\n${"a".repeat(40)} refs/heads/main\n\n`,
    );
    const pack = new Uint8Array(12 + 20);
    pack.set(new TextEncoder().encode("PACK"));
    new DataView(pack.buffer).setUint32(4, 9);
    const bytes = new Uint8Array(header.byteLength + pack.byteLength);
    bytes.set(header);
    bytes.set(pack, header.byteLength);

    expect(await offers(bytes, "a".repeat(40))).toEqual({
      status: "unusable",
      reason: "git bundle packfile is version 9",
    });
  });

  test("reports bytes that are not a bundle at all", async () => {
    expect(
      await offers(new TextEncoder().encode("hello"), "a".repeat(40)),
    ).toEqual({ status: "unusable", reason: "not a git bundle" });
  });
});

describe("gitBundleOffersFrom", () => {
  test("stops reading once the header has settled the answer", async () => {
    const { directory } = await repository(2);
    const bytes = await bundle(directory, ["main"]);
    let pulled = 0;
    let closed = false;
    async function* counted() {
      try {
        for await (const chunk of refilled(bytes, 16)) {
          pulled += 1;
          yield chunk;
        }
      } finally {
        closed = true;
      }
    }

    expect(await gitBundleOffersFrom(counted(), "b".repeat(40))).toMatchObject({
      status: "unusable",
    });
    expect(pulled).toBeLessThan(Math.ceil(bytes.byteLength / 16));
    // Ending early has to let go of the source, or a store's socket leaks.
    expect(closed).toBe(true);
  });

  test("gives up on a header that never terminates without reading the rest", async () => {
    let pulled = 0;
    async function* endless() {
      yield new TextEncoder().encode("# v2 git bundle\n");
      for (;;) {
        pulled += 1;
        yield new Uint8Array(64 * 1024).fill(0x61);
      }
    }

    expect(await gitBundleOffersFrom(endless(), "a".repeat(40))).toEqual({
      status: "unusable",
      reason: "not a git bundle",
    });
    expect(pulled).toBeLessThanOrEqual(17);
  });
});

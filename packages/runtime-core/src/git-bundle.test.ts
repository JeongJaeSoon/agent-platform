import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitBundleOffers, readGitBundleHeader } from "./git-bundle.ts";

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
    const header = readGitBundleHeader(await bundle(directory, ["main"]));

    expect(header).toEqual({
      capabilities: [],
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

describe("gitBundleOffers", () => {
  test("offers the ref whose tip is the commit", async () => {
    const { directory, shas } = await repository(2);

    expect(
      gitBundleOffers(await bundle(directory, ["main"]), shas[1] as string),
    ).toEqual({ status: "offers", refs: ["refs/heads/main"] });
  });

  test("refuses a commit that is only inside the history", async () => {
    // The parent is in the packfile, but a fetch asks for refs, so nothing can
    // name it. A checkpoint pinning it would not restore.
    const { directory, shas } = await repository(2);

    expect(
      gitBundleOffers(await bundle(directory, ["main"]), shas[0] as string),
    ).toMatchObject({ status: "unusable" });
  });

  test("refuses a commit the bundle has never heard of", async () => {
    const { directory } = await repository(1);

    expect(
      gitBundleOffers(await bundle(directory, ["main"]), "b".repeat(40)),
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

    expect(gitBundleOffers(incremental, shas[1] as string)).toEqual({
      status: "unusable",
      reason:
        "git bundle needs 1 prerequisite commit(s) a fresh workspace does not have",
    });
  });

  test("refuses a bundle whose object format is not the one the manifest pins", () => {
    const text = `# v3 git bundle\n@object-format=sha256\n${"c".repeat(64)} refs/heads/main\n\nPACK`;

    expect(
      gitBundleOffers(new TextEncoder().encode(text), "c".repeat(64)),
    ).toEqual({
      status: "unusable",
      reason: "git bundle uses object format sha256",
    });
  });

  test("reports bytes that are not a bundle at all", () => {
    expect(
      gitBundleOffers(new TextEncoder().encode("hello"), "a".repeat(40)),
    ).toEqual({ status: "unusable", reason: "not a git bundle" });
  });
});

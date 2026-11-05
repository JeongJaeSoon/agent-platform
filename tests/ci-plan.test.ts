import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ci-plan-"));
const script = join(import.meta.dir, "../.github/scripts/ci-plan.sh");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function put(repo: string, path: string, body: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
}

function commit(repo: string) {
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=CI tests",
    "-c",
    "user.email=ci-tests@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  return git(repo, "rev-parse", "HEAD");
}

function fixture(before: string[] = ["README.md"], after: string[] = []) {
  const repo = mkdtempSync(join(root, "repo-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  for (const path of before) put(repo, path, "before\n");
  const base = commit(repo);
  git(repo, "remote", "add", "origin", repo);
  for (const path of after) put(repo, path, "after\n");
  if (after.length > 0) commit(repo);
  const temporary = join(root, `temp-${repo.split("/").at(-1)}`);
  mkdirSync(temporary);
  return { repo, base, temporary, output: join(temporary, "output") };
}

function plan(
  f: ReturnType<typeof fixture>,
  event = "pull_request",
  base = f.base,
) {
  const result = Bun.spawnSync(["bash", script], {
    cwd: f.repo,
    env: {
      ...Bun.env,
      GITHUB_EVENT_NAME: event,
      BASE_SHA: base,
      RUNNER_TEMP: f.temporary,
      GITHUB_OUTPUT: f.output,
    },
  });
  const output = existsSync(f.output) ? readFileSync(f.output, "utf8") : "";
  return {
    exitCode: result.exitCode,
    output: Object.fromEntries(
      output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    ),
    stderr: result.stderr.toString(),
  };
}

function mergePullRequest(f: ReturnType<typeof fixture>, base = f.base) {
  git(f.repo, "branch", "pull-request");
  git(f.repo, "switch", "--detach", base);
  git(
    f.repo,
    "-c",
    "user.name=CI tests",
    "-c",
    "user.email=ci-tests@example.invalid",
    "merge",
    "--no-ff",
    "--no-edit",
    "pull-request",
  );
}

const full = {
  tests: "true",
  product: "true",
  site: "true",
  quickstart: "true",
  docs_only: "false",
};

test("prose-only PRs keep a small explicit plan", () => {
  const result = plan(fixture(undefined, ["docs/operator/settings.md"]));
  expect(result.exitCode).toBe(0);
  expect(result.output).toEqual({
    tests: "false",
    product: "false",
    site: "false",
    quickstart: "false",
    docs_only: "true",
  });
});

test("site content keeps the current docs, storybook and assembly chain", () => {
  const result = plan(fixture(undefined, ["apps/docs/content/docs/intro.mdx"]));
  expect(result.exitCode).toBe(0);
  expect(result.output.site).toBe("true");
  expect(result.output.product).toBe("false");
});

test("both executable guides keep quickstart even in a docs-only PR", () => {
  for (const path of [
    "docs/quickstart.md",
    "apps/docs/content/docs/reference/api-guide.mdx",
  ]) {
    const result = plan(fixture(undefined, [path]));
    expect(result.exitCode).toBe(0);
    expect(result.output.quickstart).toBe("true");
    expect(result.output.docs_only).toBe("true");
  }
});

test("mixed, unknown, workflow and dependency changes always use the full plan", () => {
  for (const path of [
    "packages/db/src/query.ts",
    ".github/workflows/ci.yml",
    "bun.lock",
    "apps/docs/next.config.ts",
    "new-directory/file.md",
    "packages/x/README.md",
    "docs/page.MD",
    "apps/docs/content/docs/meta.json",
  ]) {
    const result = plan(
      fixture(undefined, ["docs/operator/settings.md", path]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual(full);
  }
});

test("main, manual and empty PR diffs use the full plan", () => {
  for (const event of ["push", "workflow_dispatch", "pull_request"]) {
    const result = plan(fixture(), event);
    expect(result.exitCode).toBe(0);
    expect(result.output).toEqual(full);
  }
});

test("a later prose commit cannot hide code already in the PR", () => {
  const f = fixture(undefined, ["packages/a.ts"]);
  put(f.repo, "docs/operator/settings.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f);
  expect(plan(f).output).toEqual(full);
});

test("a merge checkout keeps multi-commit prose PRs eligible", () => {
  const f = fixture(undefined, ["docs/first.md"]);
  put(f.repo, "docs/second.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f);
  expect(plan(f).output.docs_only).toBe("true");
});

test("an event base that differs from the checkout parent uses full validation", () => {
  const f = fixture(["README.md", "packages/a.ts"], ["packages/a.ts"]);
  const actualBase = git(f.repo, "rev-parse", "HEAD");
  put(f.repo, "packages/a.ts", "before\n");
  put(f.repo, "docs/prose.md", "prose\n");
  commit(f.repo);
  mergePullRequest(f, actualBase);
  expect(plan(f).output).toEqual(full);
});

test("renames and deletions classify the old path as well as the new one", () => {
  const f = fixture(["packages/a.ts"]);
  mkdirSync(join(f.repo, "docs"));
  git(f.repo, "mv", "packages/a.ts", "docs/renamed.md");
  commit(f.repo);
  expect(plan(f).output).toEqual(full);
  const deleted = fixture(["README.md", "docs/operator/settings.md"]);
  git(deleted.repo, "rm", "docs/operator/settings.md");
  commit(deleted.repo);
  expect(plan(deleted).output.docs_only).toBe("true");
});

test("spaces, quotes and newlines in paths stay data", () => {
  const f = fixture(undefined, ["docs/space ' quote\nname.md"]);
  const result = plan(f);
  expect(result.exitCode).toBe(0);
  expect(result.output.docs_only).toBe("true");
});

test("invalid bases and failed fetches fail before publishing any plan", () => {
  const invalid = fixture(undefined, ["docs/intro.md"]);
  const result = plan(invalid, "pull_request", "--upload-pack=unexpected");
  expect(result.exitCode).not.toBe(0);
  expect(result.output).toEqual({});
  const missing = fixture(undefined, ["docs/intro.md"]);
  git(missing.repo, "remote", "set-url", "origin", join(root, "missing"));
  const failed = plan(missing);
  expect(failed.exitCode).not.toBe(0);
  expect(failed.output).toEqual({});
});

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripts = join(import.meta.dir, "..", ".github", "scripts");

type Outcome = {
  calls: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Runs a script with a fake `gh` first on PATH. The fake logs every invocation
 * to a file and answers from `replies`, keyed by the first words of the
 * invocation; an unmatched call exits 9 so a test never passes by accident.
 */
async function run(
  script: string,
  args: string[],
  replies: Record<string, string>,
  env: Record<string, string> = {},
): Promise<Outcome> {
  const directory = await mkdtemp(join(tmpdir(), "ci-issue-"));
  const log = join(directory, "calls.log");
  const fakeGh = join(directory, "gh");
  const cases = Object.entries(replies)
    .map(
      ([prefix, reply]) =>
        `  "${prefix}"*) printf '%s\\n' ${JSON.stringify(reply)} ;;`,
    )
    .join("\n");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${log}"
case "$*" in
${cases}
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`,
  );
  await chmod(fakeGh, 0o755);
  try {
    const process = Bun.spawn([join(scripts, script), ...args], {
      env: {
        ...Bun.env,
        GH_REPO: "octo/repo",
        ...env,
        PATH: `${directory}:${Bun.env.PATH}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const calls = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    return { calls, exitCode, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function bodyFile(): Promise<{
  path: string;
  dispose: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ci-issue-body-"));
  const path = join(directory, "body.md");
  await writeFile(path, "<!-- marker -->\nsomething broke\n");
  return {
    path,
    dispose: () => rm(directory, { force: true, recursive: true }),
  };
}

describe("upsert-ci-issue.sh", () => {
  test("creates the issue when none is open under the label", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        ["ci-spikes-failure", "CI: spikes failed (non-blocking job)", body.path],
        {
          "label create": "",
          "issue list": "",
          "issue create": "https://github.com/octo/repo/issues/12",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(
        "created https://github.com/octo/repo/issues/12\n",
      );
      expect(
        outcome.calls.some((call) => call.startsWith("issue comment")),
      ).toBe(false);
      const create = outcome.calls.find((call) =>
        call.startsWith("issue create"),
      );
      expect(create).toContain("--label ci-spikes-failure");
      expect(create).toContain("--title CI: spikes failed (non-blocking job)");
    } finally {
      await body.dispose();
    }
  });

  test("comments on the open issue instead of opening a second one", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        ["ci-spikes-failure", "CI: spikes failed (non-blocking job)", body.path],
        {
          "label create": "",
          "issue list": "12",
          "issue comment 12": "",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("updated #12\n");
      expect(
        outcome.calls.some((call) => call.startsWith("issue create")),
      ).toBe(false);
    } finally {
      await body.dispose();
    }
  });

  test("looks the open issue up through the list endpoint, filtered by label", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        ["ci-missing-push-run", "CI: main tip has no push run", body.path],
        { "label create": "", "issue list": "", "issue create": "url" },
      );

      const list = outcome.calls.find((call) => call.startsWith("issue list"));
      expect(list).toContain("--label ci-missing-push-run");
      expect(list).toContain("--state open");
      expect(list).not.toContain("--search");
    } finally {
      await body.dispose();
    }
  });

  test("refuses a missing body file before touching GitHub", async () => {
    const outcome = await run(
      "upsert-ci-issue.sh",
      ["ci-spikes-failure", "title", "/nonexistent/body.md"],
      {},
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.calls).toEqual([]);
  });
});

describe("check-main-push-run.sh", () => {
  const oldCommit = (sha: string) => `${sha} 2026-09-22T14:27:16Z`;

  test("reports present when the commit has a push run of ci.yml", async () => {
    const outcome = await run("check-main-push-run.sh", ["10e58fb"], {
      "api repos/octo/repo/commits/10e58fb": oldCommit("10e58fb0000"),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=10e58fb0000&per_page=1":
        "1",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("present\n");
  });

  test("reports missing, with exit 1, when no push run exists for the commit", async () => {
    const outcome = await run("check-main-push-run.sh", ["70139eb"], {
      "api repos/octo/repo/commits/70139eb": oldCommit("70139eb0000"),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=70139eb0000&per_page=1":
        "0",
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("missing\n");
  });

  test("checks the main tip when no sha is given", async () => {
    const outcome = await run("check-main-push-run.sh", [], {
      "api repos/octo/repo/commits/main": oldCommit("abc"),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=abc&per_page=1":
        "1",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("present\n");
  });

  test("does not judge a commit younger than the grace period", async () => {
    const justNow = new Date().toISOString();
    const outcome = await run("check-main-push-run.sh", ["fresh"], {
      "api repos/octo/repo/commits/fresh": `fresh0000 ${justNow}`,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("too-recent\n");
    expect(outcome.calls.some((call) => call.includes("/actions/"))).toBe(
      false,
    );
  });

  test("a zero grace period judges a fresh commit", async () => {
    const justNow = new Date().toISOString();
    const outcome = await run(
      "check-main-push-run.sh",
      ["fresh"],
      {
        "api repos/octo/repo/commits/fresh": `fresh0000 ${justNow}`,
        "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=fresh0000&per_page=1":
          "0",
      },
      { MIN_AGE_MINUTES: "0" },
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("missing\n");
  });
});

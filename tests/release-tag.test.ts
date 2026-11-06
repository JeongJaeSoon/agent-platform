import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartVersion } from "../.github/scripts/chart-package.ts";

// release.yml turns one Run workflow into "tag, then the tag publish path".
// These tests hold the order of its steps, the single approval, and what
// `release-tag.sh` refuses, against a fake `gh`. Starting a real run is the
// owner's first release.

const root = join(import.meta.dir, "..");
const script = join(root, ".github", "scripts", "release-tag.sh");
const read = (path: string) => Bun.file(join(root, path)).text();

type Step = { name?: string; run?: string; uses?: string };
type Job = {
  environment?: string;
  permissions?: Record<string, string>;
  if?: string;
  steps: Step[];
};

const sha = "0123456789abcdef0123456789abcdef01234567";
const version = "v0.1.2";

/** One reply of the fake `gh`: the first entry whose `match` is in the argv wins. */
type Reply = { match: string; out?: string; code?: number };

type Outcome = { calls: string[]; code: number; stderr: string };

async function run(
  subcommand: string,
  replies: Reply[],
  env: Record<string, string> = {},
): Promise<Outcome> {
  const directory = await mkdtemp(join(tmpdir(), "release-tag-"));
  try {
    const log = join(directory, "calls.log");
    const cases = replies
      .map(
        ({ match, out = "", code = 0 }) =>
          `  *${JSON.stringify(match)}*) printf '%s' ${JSON.stringify(out)}; [ ${code} = 0 ] || echo "gh: failed ${out}" >&2; exit ${code} ;;`,
      )
      .join("\n");
    await writeFile(
      join(directory, "gh"),
      `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args//$'\\n'/ }" >>"${log}"
case "$*" in
${cases}
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`,
    );
    await chmod(join(directory, "gh"), 0o755);
    const proc = Bun.spawn(["bash", script, subcommand], {
      env: {
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        HOME: directory,
        VERSION: version,
        SHA: sha,
        GH_REPO: "owner/repo",
        GH_TOKEN: "fake",
        GITHUB_REF: "refs/heads/main",
        DISPATCH_WAIT: "0",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const calls = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    return { calls, code, stderr: await new Response(proc.stderr).text() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The tag-path `if` the script looks for in the commit's images.yml. */
const gate = (
  readFileSync(script, "utf8").match(/^tag_gate="(.*)"$/m)?.[1] ?? ""
).replaceAll('\\"', '"');

const green = (workflow: string): Reply => ({
  match: `actions/workflows/${workflow}/runs`,
  out: "completed success https://example.test/run",
});

/** Every call `check` makes, answering as a releasable commit would. */
const releasable = (tag = version): Reply[] => [
  { match: "compare/main...", out: "behind" },
  { match: `git/ref/tags/${tag}`, code: 1, out: "Not Found (HTTP 404)" },
  { match: "releases?per_page", out: "" },
  green("ci.yml"),
  green("images.yml"),
  { match: "contents/.github/workflows/images.yml", out: `if: ${gate}` },
];

describe("release.yml", () => {
  const { on, permissions, jobs } = Bun.YAML.parse(
    readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
  ) as {
    on: {
      workflow_dispatch: { inputs: Record<string, { required: boolean }> };
    };
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };

  test("starts only from Run workflow with a version and a commit", () => {
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
    expect(on.workflow_dispatch.inputs.version?.required).toBe(true);
    expect(on.workflow_dispatch.inputs.sha?.required).toBe(true);
  });

  test("one job checks, then tags, then dispatches, in that order", () => {
    expect(Object.keys(jobs)).toEqual(["tag"]);
    const commands = (jobs.tag?.steps ?? [])
      .map((step) => step.run?.match(/release-tag\.sh (\w+)/)?.[1])
      .filter(Boolean);
    expect(commands).toEqual(["check", "tag", "dispatch"]);
  });

  test("asks for no approval, and holds no package write", () => {
    expect(JSON.stringify(jobs)).not.toContain('"environment"');
    expect(permissions).toEqual({ contents: "read" });
    expect(jobs.tag?.permissions).toEqual({
      contents: "write",
      actions: "write",
    });
  });

  test("the approval is the one in front of images.yml's publish", () => {
    const images = Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/images.yml"), "utf8"),
    ) as { jobs: Record<string, Job> };
    const withEnvironment = Object.entries(images.jobs)
      .filter(([, job]) => job.environment !== undefined)
      .map(([name]) => name);
    expect(withEnvironment).toEqual(["publish"]);
  });

  test("every tag-path job of images.yml carries the gate the script looks for", async () => {
    const images = Bun.YAML.parse(
      await read(".github/workflows/images.yml"),
    ) as {
      jobs: Record<string, Job>;
    };
    expect(gate).not.toBe("");
    for (const name of [
      "publish",
      "sources",
      "index",
      "promote",
      "chart",
      "chart-publish",
      "release",
    ]) {
      expect(images.jobs[name]?.if).toBe(gate);
    }
    // Present in the file as text too, which is what `check` greps for.
    expect(await read(".github/workflows/images.yml")).toContain(gate);
  });
});

describe("release-tag.sh check", () => {
  test("passes for a commit on main with green CI and Images", async () => {
    const outcome = await run("check", releasable());
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);
    // The order the ticket lists: inputs, main, the tag, then CI and Images.
    const endpoint = (call: string) =>
      call
        .split(" ")
        .find((word) => word.startsWith("repos/"))
        ?.split("?")[0];
    expect(outcome.calls.map(endpoint)).toEqual([
      `repos/owner/repo/compare/main...${sha}`,
      `repos/owner/repo/git/ref/tags/${version}`,
      "repos/owner/repo/releases",
      "repos/owner/repo/actions/workflows/ci.yml/runs",
      "repos/owner/repo/actions/workflows/images.yml/runs",
      "repos/owner/repo/contents/.github/workflows/images.yml",
    ]);
  });

  test.each([
    ["v1.2", "version"],
    ["1.2.3", "version"],
    ["v1.2.3+build", "version"],
    ["v01.2.3", "version"],
    ["v1.2.3-", "version"],
    ["v1.2.3-01", "version"],
    [`v1.2.3-${"a".repeat(60)}`, "63 characters"],
  ])(
    "refuses the version %s before asking GitHub anything",
    async (bad, why) => {
      const outcome = await run("check", releasable(), { VERSION: bad });
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain(why);
      expect(outcome.calls).toEqual([]);
    },
  );

  test.each([
    "v0.1.2",
    "v10.20.30",
    "v1.2.3-rc.1",
    "v1.2.3-alpha-1",
    "v1.2.3-0",
  ])("accepts %s, as chart-package.ts does", async (good) => {
    expect(() =>
      chartVersion({
        ref: `refs/tags/${good}`,
        sha,
        chartYamlVersion: "0.0.0",
        chartName: "werft",
      }),
    ).not.toThrow();
    const outcome = await run("check", releasable(good), { VERSION: good });
    expect(outcome.stderr).toBe("");
    expect(outcome.code).toBe(0);
  });

  test("agrees with chart-package.ts on what is not a release tag", async () => {
    for (const bad of ["v1.2", "v01.2.3", "v1.2.3+b", "v1.2.3-01", "v1.2.3-"]) {
      expect(() =>
        chartVersion({
          ref: `refs/tags/${bad}`,
          sha,
          chartYamlVersion: "0.0.0",
          chartName: "werft",
        }),
      ).toThrow();
    }
  });

  test.each([
    ["short", "abc123"],
    ["upper case", sha.toUpperCase()],
    ["a branch name", "main"],
  ])("refuses a commit given as %s", async (_name, bad) => {
    const outcome = await run("check", releasable(), { SHA: bad });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("40 lowercase hex");
    expect(outcome.calls).toEqual([]);
  });

  test("refuses to run from a branch other than main", async () => {
    const outcome = await run("check", releasable(), {
      GITHUB_REF: "refs/heads/feature",
    });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("from main");
    expect(outcome.calls).toEqual([]);
  });

  test.each(["ahead", "diverged"])(
    "refuses a commit that is %s of main, not on it",
    async (status) => {
      const outcome = await run("check", [
        { match: "compare/main...", out: status },
        ...releasable(),
      ]);
      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain("is not on main");
      expect(outcome.calls).toHaveLength(1);
    },
  );

  test("refuses a commit GitHub does not know", async () => {
    const outcome = await run("check", [
      { match: "compare/main...", code: 1, out: "Not Found (HTTP 404)" },
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("could not compare");
  });

  test("refuses a tag that already exists, and creates nothing", async () => {
    const outcome = await run("check", [
      { match: `git/ref/tags/${version}`, out: "{}" },
      ...releasable(),
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("already exists");
    expect(outcome.calls.some((call) => call.includes("-X POST"))).toBe(false);
  });

  test("does not take a failed tag lookup for an absent tag", async () => {
    const outcome = await run("check", [
      {
        match: `git/ref/tags/${version}`,
        code: 1,
        out: "Server Error (HTTP 500)",
      },
      ...releasable(),
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("could not look up");
  });

  test("refuses a version that has a Release, even a draft without a tag", async () => {
    const outcome = await run("check", [
      { match: "releases?per_page", out: "12345" },
      ...releasable(),
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("Release for v0.1.2 already exists");
  });

  test.each([
    ["ci.yml", "in_progress none https://example.test/run", "in_progress"],
    [
      "ci.yml",
      "completed failure https://example.test/run",
      "concluded failure",
    ],
    ["images.yml", "queued none https://example.test/run", "queued"],
    [
      "images.yml",
      "completed cancelled https://example.test/run",
      "concluded cancelled",
    ],
    ["images.yml", "null none null", "no push run"],
  ])("refuses when %s is %s", async (workflow, out, why) => {
    const outcome = await run("check", [
      { match: `actions/workflows/${workflow}/runs`, out },
      ...releasable(),
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(why);
  });

  test("refuses a commit whose images.yml would skip every publish job", async () => {
    const outcome = await run("check", [
      {
        match: "contents/.github/workflows/images.yml",
        out: "jobs: if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      },
      ...releasable(),
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("does not publish on a dispatch");
  });
});

describe("release-tag.sh tag and dispatch", () => {
  test("creates the tag object first, then the ref to that object", async () => {
    const outcome = await run("tag", [
      { match: "git/tags", out: "feedface" },
      { match: "git/refs", out: "{}" },
    ]);
    expect(outcome.code).toBe(0);
    expect(outcome.calls).toHaveLength(2);
    expect(outcome.calls[0]).toContain(`repos/owner/repo/git/tags`);
    expect(outcome.calls[0]).toContain(`object=${sha}`);
    expect(outcome.calls[0]).toContain("type=commit");
    expect(outcome.calls[1]).toContain(`ref=refs/tags/${version}`);
    expect(outcome.calls[1]).toContain("sha=feedface");
  });

  test("stops when the ref cannot be created, so a taken tag is not moved", async () => {
    const outcome = await run("tag", [
      { match: "git/tags", out: "feedface" },
      {
        match: "git/refs",
        code: 1,
        out: "Reference already exists (HTTP 422)",
      },
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("could not create refs/tags/v0.1.2");
  });

  test("dispatches Images on the tag ref once", async () => {
    const outcome = await run("dispatch", [{ match: "workflow run", out: "" }]);
    expect(outcome.code).toBe(0);
    expect(outcome.calls).toEqual([`workflow run images.yml --ref ${version}`]);
  });

  test("retries a failed dispatch, then fails and leaves the tag alone", async () => {
    const outcome = await run("dispatch", [
      { match: "workflow run", code: 1, out: "boom" },
    ]);
    expect(outcome.code).toBe(1);
    expect(outcome.calls).toHaveLength(3);
    expect(outcome.calls.every((call) => call.startsWith("workflow run"))).toBe(
      true,
    );
    expect(outcome.stderr).toContain("The tag is not deleted");
  });
});

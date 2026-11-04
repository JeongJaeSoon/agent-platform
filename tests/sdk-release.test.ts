import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The publish gate of sdk-release.yml: nothing but a manual run on main naming
// a version, approved in the `release` environment, can mint the OIDC token npm
// trusts.

type Step = {
  uses?: string;
  name?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const text = read(".github/workflows/sdk-release.yml");
const workflow = Bun.YAML.parse(text) as Workflow;
const { build, tag, publish, ...others } = workflow.jobs;
const runs = (job: Job) => job.steps.map((step) => step.run ?? "").join("\n");
const releaseRun =
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.version != ''";
const checkStep = build?.steps.find(
  (step) => step.name === "Commit and version can be released",
) as Step;
const tagStep = tag?.steps[0] as Step;
const stepEnv = {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text
  VERSION: "${{ inputs.version }}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text
  GH_TOKEN: "${{ github.token }}",
};

describe("sdk-release.yml", () => {
  test("is read-only at the top and has only the three jobs", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(others)).toEqual([]);
  });

  test("only pull requests and manual runs start it", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "pull_request",
      "workflow_dispatch",
    ]);
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: {
        version: {
          description:
            "Version to publish, equal to packages/sdk/package.json. Empty is a dry run.",
          type: "string",
          required: false,
          default: "",
        },
      },
    });
  });

  test("tag and publish run only for a manual run on main naming a version", () => {
    expect(tag?.if).toBe(releaseRun);
    expect(publish?.if).toBe(releaseRun);
    expect(tag?.needs).toBe("build");
    expect(publish?.needs).toEqual(["build", "tag"]);
  });

  test("publish waits for approval in the release environment after the tag", () => {
    expect(publish?.environment).toBe("release");
    expect(tag?.environment).toBeUndefined();
    for (const s of [...(publish?.steps ?? []), ...(tag?.steps ?? [])])
      expect(s["continue-on-error"]).toBeUndefined();
    expect(
      publish?.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
    expect(
      tag?.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
  });

  test("build checks a release before it packs, and never for a dry run", () => {
    const steps = build?.steps ?? [];
    const packAt = steps.findIndex((s) =>
      s.run?.includes("npm pack ./packages/sdk/dist"),
    );
    expect(checkStep.if).toBe("inputs.version != ''");
    expect(steps.indexOf(checkStep)).toBeGreaterThanOrEqual(0);
    expect(packAt).toBeGreaterThan(steps.indexOf(checkStep));
  });

  test("only tag can write the repository", () => {
    expect(tag?.permissions).toEqual({ contents: "write" });
    expect(build?.permissions).toEqual({ contents: "read", actions: "read" });
  });

  test("only publish can mint the OIDC token, and no npm token remains", () => {
    expect(publish?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(runs(publish as Job).trim()).toBe(
      "npm publish ./pkg/*.tgz --provenance --access public",
    );
    expect(runs(build as Job)).not.toContain("npm publish");
    expect(text).not.toContain("secrets");
    expect(text).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow.env).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job.env).toBeUndefined();
      for (const step of job.steps)
        expect(step.env).toEqual(
          step === checkStep || step === tagStep ? stepEnv : undefined,
        );
    }
  });

  test("the version input reaches a shell only through the environment", () => {
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps) expect(step.run ?? "").not.toContain("${{");
  });

  test("publish runs on the Node whose npm supports trusted publishing", () => {
    const steps = publish?.steps ?? [];
    const nodeAt = steps.findIndex((s) =>
      s.uses?.startsWith("actions/setup-node@"),
    );
    const publishAt = steps.findIndex((s) => s.run?.includes("npm publish"));
    expect(nodeAt).toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThan(nodeAt);
    for (const step of steps) expect(step.if).toBeUndefined();
    // Node 24 bundles npm 11, which clears npm's 11.5.1 minimum.
    expect(steps[nodeAt]?.with).toEqual({
      "node-version": 24,
      "registry-url": "https://registry.npmjs.org",
    });
  });

  test("build tests, builds, smokes and packs the tarball it uploads", () => {
    const script = runs(build as Job);
    const order = [
      "bun test packages/sdk examples",
      "bun run --cwd packages/sdk build:package",
      "bun scripts/sdk-pack-smoke.ts",
      "npm pack ./packages/sdk/dist",
    ].map((command) => script.indexOf(command));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(
      build?.steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")),
    ).toBe(true);
  });

  test("pins the same action commits as the other workflows", () => {
    const pinned = `${read(".github/workflows/ci.yml")}\n${read(".github/workflows/images.yml")}\n${read(".github/workflows/ui-release.yml")}`;
    const uses = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .flatMap((step) => (step.uses?.includes("@") ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
      expect(pinned).toContain(action);
    }
  });

  test("the version it checks is the one the SDK reports", async () => {
    const pkg = await Bun.file(join(root, "packages/sdk/package.json")).json();
    expect(read("packages/sdk/src/version.ts")).toContain(
      `export const SDK_VERSION = "${pkg.version}";`,
    );
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
  });

  test("an sdk-v* tag starts no other push workflow", () => {
    expect(new Bun.Glob("v*").match("sdk-v0.1.0")).toBe(false);
    expect(new Bun.Glob("ui-v*").match("sdk-v0.1.0")).toBe(false);
  });
});

// The check and tag steps run as written, on the shell flags Actions uses:
// git against a real origin, gh as a stub that applies the step's own jq filter.
describe("sdk-release.yml release steps", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sdk-release-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.test",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.test",
      },
    });
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    return done.stdout.toString().trim();
  };

  const origin = join(scratch, "origin.git");
  const repo = join(scratch, "repo");
  const stubs = join(scratch, "bin");
  const ghCalls = join(scratch, "gh-calls");
  mkdirSync(join(repo, "packages/sdk"), { recursive: true });
  mkdirSync(stubs);
  writeFileSync(
    join(repo, "packages/sdk/package.json"),
    '{"version":"1.2.3"}\n',
  );
  git(scratch, "init", "--bare", "--initial-branch=main", origin);
  git(repo, "init", "--initial-branch=main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "release");
  git(repo, "push", "origin", "main");
  const onMain = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", "side");
  git(repo, "commit", "--allow-empty", "-m", "side");
  const offMain = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "origin", "side");

  writeFileSync(
    join(stubs, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
[ -z "$GH_FAILS" ] || exit 1
for last; do :; done
[ "$1" = api ] && [ "$3" = --jq ] && printf '%s' "$FAKE_RUNS" | jq -r "$last"
exit 0
`,
  );
  chmodSync(join(stubs, "gh"), 0o755);

  const ciRun = (conclusion: string | null) =>
    JSON.stringify({ workflow_runs: [{ conclusion }] });

  const run = (step: Step, env: Record<string, string> = {}) => {
    rmSync(ghCalls, { force: true });
    const script = join(scratch, "step.sh");
    writeFileSync(script, step.run as string);
    const done = Bun.spawnSync(["bash", "-eo", "pipefail", script], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${stubs}:${process.env.PATH}`,
        GH_CALLS: ghCalls,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: onMain,
        VERSION: "1.2.3",
        FAKE_RUNS: ciRun("success"),
        ...env,
      },
    });
    return {
      code: done.exitCode,
      out: done.stdout.toString(),
      calls: Bun.file(ghCalls).size ? readFileSync(ghCalls, "utf8") : "",
    };
  };

  test("a good release passes every check and asks CI about its own commit", () => {
    const { code, calls } = run(checkStep);
    expect(code).toBe(0);
    expect(calls).toContain(
      `repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${onMain}&event=push&branch=main&per_page=1`,
    );
  });

  const refusals: [string, Record<string, string>, string][] = [
    [
      "a run off main",
      { GITHUB_REF: "refs/heads/side" },
      "a release runs on main",
    ],
    ["a tag ref", { GITHUB_REF: "refs/tags/x" }, "a release runs on main"],
    ["another version", { VERSION: "1.2.4" }, "does not match packages/sdk"],
    ["a v prefix", { VERSION: "v1.2.3" }, "does not match packages/sdk"],
    ["a blank version", { VERSION: " " }, "does not match packages/sdk"],
    ["a commit off main", { GITHUB_SHA: offMain }, "is not on main"],
    ["a failed CI", { FAKE_RUNS: ciRun("failure") }, "is failure, not success"],
    [
      "a cancelled CI",
      { FAKE_RUNS: ciRun("cancelled") },
      "is cancelled, not success",
    ],
    [
      "a CI still running",
      { FAKE_RUNS: ciRun(null) },
      "is not finished, not success",
    ],
    [
      "no CI run",
      { FAKE_RUNS: '{"workflow_runs":[]}' },
      "is not finished, not success",
    ],
    ["a failed CI lookup", { GH_FAILS: "1" }, "could not read main CI"],
  ];
  for (const [name, env, message] of refusals)
    test(`refuses ${name}`, () => {
      const { code, out } = run(checkStep, env);
      expect(code).toBe(1);
      expect(out).toContain(`::error::`);
      expect(out).toContain(message);
    });

  test("refuses a tag that already exists", () => {
    git(repo, "push", "origin", `${onMain}:refs/tags/sdk-v1.2.3`);
    const { code, out } = run(checkStep);
    git(repo, "push", "origin", ":refs/tags/sdk-v1.2.3");
    expect(code).toBe(1);
    expect(out).toContain("tag sdk-v1.2.3 already exists");
  });

  test("stops when origin cannot say whether the tag exists", () => {
    const stub = join(stubs, "git");
    const real = Bun.which("git") as string;
    writeFileSync(
      stub,
      `#!/bin/sh
[ "$1" = ls-remote ] && exit 128
exec "${real}" "$@"
`,
    );
    chmodSync(stub, 0o755);
    const { code, out } = run(checkStep);
    rmSync(stub);
    expect(code).toBe(1);
    expect(out).toContain("could not read tag sdk-v1.2.3 from origin");
  });

  test("the tag step creates sdk-v<version> at the run's commit", () => {
    const { code, calls } = run(tagStep);
    expect(code).toBe(0);
    expect(calls.trim()).toBe(
      `api --method POST repos/owner/repo/git/refs -f ref=refs/tags/sdk-v1.2.3 -f sha=${onMain}`,
    );
  });

  test("the tag step fails when the ref cannot be created", () => {
    expect(run(tagStep, { GH_FAILS: "1" }).code).toBe(1);
  });
});

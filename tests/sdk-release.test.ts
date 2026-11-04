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

// The publish gates of sdk-release.yml. Stable: nothing but a manual run on
// main naming a version, approved in the `release` environment, can mint the
// OIDC token for `latest`. Prerelease: a push to main, in `sdk-prerelease`, can
// mint it only for <version>-main.<12 hex> under the dist-tag `main`; npm's own
// registration cannot say that, so these tests run the job's check as written.

type Step = {
  id?: string;
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
  "continue-on-error"?: boolean;
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
const {
  build,
  tag,
  publish,
  "publish-main": publishMain,
  ...others
} = workflow.jobs;
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
  test("is read-only at the top and has only the four jobs", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(others)).toEqual([]);
  });

  test("only pull requests, pushes to main and manual runs start it", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    const push = workflow.on.push as {
      branches: string[];
      paths: string[];
    };
    const pr = workflow.on.pull_request as { paths: string[] };
    expect(push.branches).toEqual(["main"]);
    expect(push.paths).toEqual(pr.paths);
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
    expect(
      publish?.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
    expect(
      tag?.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
  });

  test("no failing step or job can be stepped over on the way to publish", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job["continue-on-error"]).toBeUndefined();
      for (const step of job.steps)
        expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  test("build checks a release and SDK_VERSION before it packs", () => {
    const steps = build?.steps ?? [];
    const packAt = steps.findIndex((s) =>
      s.run?.includes("npm pack ./packages/sdk/dist"),
    );
    const sdkVersion = steps.find(
      (s) => s.name === "SDK_VERSION matches package.json",
    ) as Step;
    expect(checkStep.if).toBe("inputs.version != ''");
    expect(sdkVersion.if).toBeUndefined();
    expect(sdkVersion.run).toContain("packages/sdk/src/version.ts");
    for (const step of [checkStep, sdkVersion]) {
      expect(steps.indexOf(step)).toBeGreaterThanOrEqual(0);
      expect(packAt).toBeGreaterThan(steps.indexOf(step));
    }
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
          step === checkStep || step === tagStep
            ? stepEnv
            : step.id === "check"
              ? { GH_TOKEN: stepEnv.GH_TOKEN }
              : undefined,
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

const mainSteps = publishMain?.steps ?? [];
const mainCheck = mainSteps.find((step) => step.id === "check") as Step;
const stampStep = build?.steps.find(
  (step) => step.name === "Stamp the main prerelease version",
) as Step;
const mainPublish =
  "npm publish ./pkg/*.tgz --tag main --provenance --access public";

describe("sdk-release.yml prerelease path", () => {
  test("publish-main runs for a push to main once the variable is on, in its own environment", () => {
    expect(publishMain?.if).toBe(
      "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.SDK_PRERELEASE == 'true'",
    );
    expect(publishMain?.needs).toBe("build");
    expect(publishMain?.environment).toBe("sdk-prerelease");
    expect(publishMain?.environment).not.toBe(publish?.environment);
    expect(
      mainSteps.some((step) => step.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
  });

  test("the release jobs never run on a push, and the prerelease job never on a manual run", () => {
    expect(tag?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(publish?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(publishMain?.if).toContain("github.event_name == 'push'");
    expect(publishMain?.if).not.toContain("workflow_dispatch");
    expect(stampStep.if).toBe("github.event_name == 'push'");
  });

  test("only the two publish jobs can mint the OIDC token", () => {
    expect(publishMain?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    const minting = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.["id-token"] !== undefined)
      .map(([name]) => name);
    expect(minting).toEqual(["publish", "publish-main"]);
    expect(workflow.permissions["id-token"]).toBeUndefined();
  });

  test("the only npm publish with a tag is the literal main one, after the check", () => {
    const at = mainSteps.findIndex((step) => step.run?.includes("npm publish"));
    expect(at).toBe(mainSteps.length - 1);
    expect(at).toBeGreaterThan(mainSteps.indexOf(mainCheck));
    expect(mainSteps[at]?.run).toBe(mainPublish);
    expect(mainSteps[at]?.if).toBe("steps.check.outputs.publish == 'true'");
    expect(runs(publishMain as Job)).not.toContain("latest");
    for (const [name, job] of Object.entries(workflow.jobs))
      if (name !== "publish-main" && name !== "publish")
        expect(runs(job)).not.toContain("npm publish");
    expect(runs(publish as Job)).not.toContain("--tag");
  });
});

// The stamp and check steps run as written, with gh and npm as stubs.
describe("sdk-release.yml prerelease steps", () => {
  const scratch = mkdtempSync(join(tmpdir(), "sdk-main-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const sha = "0123456789abcdef0123456789abcdef01234567";
  const short = sha.slice(0, 12);
  const stubs = join(scratch, "bin");
  mkdirSync(stubs);
  writeFileSync(
    join(stubs, "gh"),
    `#!/bin/sh
[ -z "$GH_FAILS" ] || exit 1
printf '%s' "$FAKE_HEAD"
`,
  );
  writeFileSync(
    join(stubs, "npm"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_CALLS"
case "$NPM_VIEW" in
  exists) echo 1.0.0 ;;
  missing) echo "npm error code E404" >&2; exit 1 ;;
  *) echo "npm error code ECONNRESET" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(stubs, "gh"), 0o755);
  chmodSync(join(stubs, "npm"), 0o755);

  let n = 0;
  const fresh = () => {
    const dir = join(scratch, `case-${n++}`);
    mkdirSync(dir);
    return dir;
  };

  const exec = (step: Step, cwd: string, env: Record<string, string>) => {
    const script = join(scratch, `step-${n++}.sh`);
    writeFileSync(script, step.run as string);
    const output = join(cwd, "github-output");
    writeFileSync(output, "");
    const done = Bun.spawnSync(["bash", "-eo", "pipefail", script], {
      cwd,
      env: {
        ...process.env,
        PATH: `${stubs}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        NPM_CALLS: join(cwd, "npm-calls"),
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: sha,
        GITHUB_REPOSITORY: "owner/repo",
        FAKE_HEAD: sha,
        NPM_VIEW: "missing",
        ...env,
      },
    });
    return {
      code: done.exitCode,
      out: done.stdout.toString(),
      output: readFileSync(output, "utf8"),
    };
  };

  // A pack directory with one tarball whose package.json is `manifest`.
  const packed = (manifest: object, count = 1) => {
    const dir = fresh();
    mkdirSync(join(dir, "package"));
    writeFileSync(join(dir, "package/package.json"), JSON.stringify(manifest));
    mkdirSync(join(dir, "pkg"));
    for (let i = 0; i < count; i++)
      Bun.spawnSync([
        "tar",
        "-czf",
        join(dir, `pkg/sdk-${i}.tgz`),
        "-C",
        dir,
        "package",
      ]);
    return dir;
  };
  const sdk = (version: string, extra: object = {}) => ({
    name: "@werft-ai/sdk",
    version,
    ...extra,
  });

  test("a prerelease of this commit, still the head of main and not on npm, is published", () => {
    const { code, output } = exec(
      mainCheck,
      packed(sdk(`0.1.2-main.${short}`)),
      {},
    );
    expect(code).toBe(0);
    expect(output).toBe("publish=true\n");
  });

  const refusals: [string, object, Record<string, string>, string][] = [
    ["a stable version", sdk("0.1.2"), {}, "is not <x.y.z>-main."],
    ["a release candidate", sdk("0.1.2-rc.1"), {}, "is not <x.y.z>-main."],
    [
      "another commit's hash",
      sdk("0.1.2-main.deadbeefdead"),
      {},
      "is not <x.y.z>-main.",
    ],
    ["a short hash", sdk("0.1.2-main.0123456"), {}, "is not <x.y.z>-main."],
    ["a long hash", sdk(`0.1.2-main.${short}ab`), {}, "is not <x.y.z>-main."],
    [
      "a hash with a suffix",
      sdk(`0.1.2-main.${short}.1`),
      {},
      "is not <x.y.z>-main.",
    ],
    [
      "a publishConfig tag of latest",
      sdk(`0.1.2-main.${short}`, { publishConfig: { tag: "latest" } }),
      {},
      "publishConfig.tag is latest",
    ],
    [
      "another package",
      { name: "@werft-ai/other", version: `0.1.2-main.${short}` },
      {},
      "not @werft-ai/sdk",
    ],
    [
      "a manual run",
      sdk(`0.1.2-main.${short}`),
      { GITHUB_EVENT_NAME: "workflow_dispatch" },
      "publishes from a push to main",
    ],
    [
      "another branch",
      sdk(`0.1.2-main.${short}`),
      { GITHUB_REF: "refs/heads/side" },
      "publishes from a push to main",
    ],
    [
      "a commit that is not a full hash",
      sdk(`0.1.2-main.${short}`),
      { GITHUB_SHA: short },
      "GITHUB_SHA is not a commit hash",
    ],
    [
      "a head lookup that fails",
      sdk(`0.1.2-main.${short}`),
      { GH_FAILS: "1" },
      "could not read the head of main",
    ],
    [
      "an npm lookup that errors",
      sdk(`0.1.2-main.${short}`),
      { NPM_VIEW: "broken" },
      "could not look up",
    ],
  ];
  for (const [name, manifest, env, message] of refusals)
    test(`refuses ${name}`, () => {
      const { code, out, output } = exec(mainCheck, packed(manifest), env);
      expect(code).toBe(1);
      expect(out).toContain("::error::");
      expect(out).toContain(message);
      expect(output).not.toContain("publish=true");
    });

  test("refuses no tarball and two tarballs", () => {
    for (const count of [0, 2]) {
      const { code, out, output } = exec(
        mainCheck,
        packed(sdk(`0.1.2-main.${short}`), count),
        {},
      );
      expect(code).toBe(1);
      expect(out).toContain("expected one tarball");
      expect(output).not.toContain("publish=true");
    }
  });

  test("skips, without failing, a commit that is no longer the head of main", () => {
    const { code, out, output } = exec(
      mainCheck,
      packed(sdk(`0.1.2-main.${short}`)),
      { FAKE_HEAD: "f".repeat(40) },
    );
    expect(code).toBe(0);
    expect(out).toContain("is not the head of main");
    expect(output).toBe("publish=false\n");
  });

  test("skips, without failing, a version npm already has", () => {
    const { code, out, output } = exec(
      mainCheck,
      packed(sdk(`0.1.2-main.${short}`)),
      { NPM_VIEW: "exists" },
    );
    expect(code).toBe(0);
    expect(out).toContain("is already on npm");
    expect(output).toBe("publish=false\n");
  });

  test("the stamp step makes the version the check accepts, and nothing else", () => {
    const dir = fresh();
    mkdirSync(join(dir, "packages/sdk/src"), { recursive: true });
    writeFileSync(
      join(dir, "packages/sdk/package.json"),
      `${JSON.stringify({ name: "@werft-ai/sdk", version: "0.1.2" }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, "packages/sdk/src/version.ts"),
      'export const SDK_VERSION = "0.1.2";\nexport const API_SPEC_VERSION = "0.1.0-alpha";\n',
    );
    const stamped = exec(stampStep, dir, {});
    expect(stamped.code).toBe(0);
    const stampedVersion = JSON.parse(
      readFileSync(join(dir, "packages/sdk/package.json"), "utf8"),
    ).version;
    expect(stampedVersion).toBe(`0.1.2-main.${short}`);
    expect(readFileSync(join(dir, "packages/sdk/src/version.ts"), "utf8")).toBe(
      `export const SDK_VERSION = "${stampedVersion}";\nexport const API_SPEC_VERSION = "0.1.0-alpha";\n`,
    );
    expect(exec(mainCheck, packed(sdk(stampedVersion)), {}).output).toBe(
      "publish=true\n",
    );
  });

  for (const base of ["0.1.2-rc.1", "0.1.2-main.abcdefabcdef", "", "v0.1.2"])
    test(`the stamp step refuses a package version of "${base}"`, () => {
      const dir = fresh();
      mkdirSync(join(dir, "packages/sdk/src"), { recursive: true });
      writeFileSync(
        join(dir, "packages/sdk/package.json"),
        JSON.stringify({ name: "@werft-ai/sdk", version: base }),
      );
      const { code, out } = exec(stampStep, dir, {});
      expect(code).toBe(1);
      expect(out).toContain("is not a stable x.y.z");
    });
});

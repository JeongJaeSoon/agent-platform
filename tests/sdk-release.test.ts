import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The publish gate of sdk-release.yml: nothing but a pushed sdk-v* tag,
// approved in the `release` environment, reaches NPM_TOKEN.

type Step = {
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const text = read(".github/workflows/sdk-release.yml");
const workflow = Bun.YAML.parse(text) as Workflow;
const { build, publish, ...others } = workflow.jobs;
const runs = (job: Job) => job.steps.map((step) => step.run ?? "").join("\n");

describe("sdk-release.yml", () => {
  test("is read-only at the top and has only the two jobs", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(others)).toEqual([]);
  });

  test("a push starts it only for sdk-v* tags", () => {
    expect(workflow.on.push).toEqual({ tags: ["sdk-v*"] });
  });

  test("publish needs a pushed sdk-v* tag and the release environment", () => {
    expect(publish?.if).toBe(
      "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/sdk-v')",
    );
    expect(publish?.environment).toBe("release");
    expect(publish?.needs).toBe("build");
    for (const s of publish?.steps ?? [])
      expect(s["continue-on-error"]).toBeUndefined();
    expect(
      publish?.steps.some((s) => s.uses?.startsWith("actions/checkout@")),
    ).toBe(false);
  });

  test("build fails an sdk-v* tag off main or naming another version", () => {
    const steps = build?.steps ?? [];
    const onMain = steps.findIndex((step) =>
      step.run?.includes(
        'if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then',
      ),
    );
    const version = steps.findIndex((step) =>
      step.run?.includes('"${GITHUB_REF_NAME#sdk-v}" != "$version"'),
    );
    const packAt = steps.findIndex((s) =>
      s.run?.includes("npm pack ./packages/sdk/dist"),
    );
    for (const at of [onMain, version]) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(steps[at]?.if).toBe("startsWith(github.ref, 'refs/tags/sdk-v')");
      expect(steps[at]?.run).toContain("exit 1");
      expect(packAt).toBeGreaterThan(at);
    }
  });

  test("only publish sees the npm token and signs provenance", () => {
    expect(publish?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(build?.permissions).toBeUndefined();
    expect(runs(publish as Job).trim()).toBe(
      "npm publish pkg/*.tgz --provenance --access public",
    );
    expect(runs(build as Job)).not.toContain("npm publish");
    expect(text.match(/secrets\.[A-Z_]+/g)).toEqual(["secrets.NPM_TOKEN"]);
    const step = publish?.steps.find((s) => s.run?.includes("npm publish"));
    expect(step?.env).toEqual({
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
    });
  });

  test("build tests, builds, smokes and packs the tarball it uploads", () => {
    const script = runs(build as Job);
    const order = [
      "bun test packages/sdk examples/sdk-approver",
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

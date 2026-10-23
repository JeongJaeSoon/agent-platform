import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The publish gate of ui-release.yml: nothing but a pushed ui-v* tag, approved
// in the `release` environment, reaches a token that can write packages.

type Step = {
  uses?: string;
  run?: string;
  name?: string;
  if?: string;
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
const text = read(".github/workflows/ui-release.yml");
const workflow = Bun.YAML.parse(text) as Workflow;
const { build, publish, ...others } = workflow.jobs;
const runs = (job: Job) => job.steps.map((step) => step.run ?? "").join("\n");

describe("ui-release.yml", () => {
  test("is read-only at the top and has only the two jobs", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(others)).toEqual([]);
  });

  test("a push starts it only for ui-v* tags", () => {
    expect(workflow.on.push).toEqual({ tags: ["ui-v*"] });
  });

  test("publish needs a pushed ui-v* tag and the release environment", () => {
    // `workflow_dispatch` may name any ref, tags included, so the event is
    // part of the gate.
    expect(publish?.if).toBe(
      "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/ui-v')",
    );
    // An environment name the repository does not have would be created on
    // the first run, unprotected.
    expect(publish?.environment).toBe("release");
    expect(publish?.needs).toBe("build");
    // Runs unconditionally, fails the job, and comes before the publish.
    const onMain = publish?.steps.findIndex((step) =>
      step.run?.includes(
        'if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then',
      ),
    );
    const step = publish?.steps[onMain ?? -1];
    expect(step?.run).toContain("exit 1");
    expect(step?.if).toBeUndefined();
    expect(step?.["continue-on-error"]).toBeUndefined();
    const publishAt = publish?.steps.findIndex((s) =>
      s.run?.includes("npm publish"),
    );
    expect(onMain).toBeGreaterThanOrEqual(0);
    expect(publishAt).toBeGreaterThan(onMain ?? Infinity);
    for (const s of publish?.steps ?? [])
      expect(s["continue-on-error"]).toBeUndefined();
  });

  test("only publish holds package write, and only publish publishes", () => {
    expect(publish?.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(build?.permissions).toBeUndefined();
    expect(runs(publish as Job)).toContain("npm publish");
    expect(runs(build as Job)).not.toContain("npm publish");
  });

  test("names no repository secret", () => {
    expect(text).not.toMatch(/secrets\./);
  });

  test("build tests, builds, smokes and packs the tarball it uploads", () => {
    const script = runs(build as Job);
    const order = [
      "bun test packages/ui",
      "bun run --cwd packages/ui build:package",
      "bun scripts/ui-pack-smoke.ts",
      "npm pack ./packages/ui/dist",
    ].map((command) => script.indexOf(command));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const upload = build?.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    expect(upload).toBeDefined();
  });

  test("pins the same action commits as the other workflows", () => {
    const pinned = `${read(".github/workflows/ci.yml")}\n${read(".github/workflows/images.yml")}`;
    const uses = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .flatMap((step) => (step.uses?.includes("@") ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action).toMatch(/@[0-9a-f]{40}$/);
      expect(pinned).toContain(action);
    }
  });

  // images.yml publishes on v* tags and ci.yml builds only main; a ui-v* tag
  // must start neither.
  test("a ui-v* tag starts no other push workflow", () => {
    const pushOf = (file: string) =>
      (Bun.YAML.parse(read(file)) as { on: { push: unknown } }).on.push;
    expect(pushOf(".github/workflows/images.yml")).toEqual({
      branches: ["main"],
      tags: ["v*"],
    });
    expect(new Bun.Glob("v*").match("ui-v0.1.0")).toBe(false);
    expect(pushOf(".github/workflows/ci.yml")).toEqual({ branches: ["main"] });
  });
});

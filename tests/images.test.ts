import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// What the image definitions promise without a daemon: every app Dockerfile
// pins one and the same base digest, compose points at files that exist, and
// the images workflow builds every app compose runs. Building and smoking the
// images is images.yml's job.

const root = join(import.meta.dir, "..");
const apps = ["api", "scheduler", "worker"] as const;
const read = (path: string) => readFileSync(join(root, path), "utf8");

const basePins = Object.fromEntries(
  apps.map((app) => {
    const source = read(`apps/${app}/Dockerfile`);
    const pin = source.match(/^ARG BUN_IMAGE=(\S+)$/m)?.[1];
    return [app, { pin, source }];
  }),
) as Record<(typeof apps)[number], { pin?: string; source: string }>;

describe("app Dockerfiles", () => {
  test.each(apps)("%s pins its base image by digest", (app) => {
    const { pin, source } = basePins[app];
    expect(pin).toMatch(/^oven\/bun:1\.3\.10@sha256:[0-9a-f]{64}$/);
    // Every FROM goes through the ARG; a literal tag would silently float.
    const froms = source.match(/^FROM .*$/gm) ?? [];
    expect(froms.length).toBeGreaterThan(1);
    for (const line of froms) expect(line).toMatch(/^FROM \$\{BUN_IMAGE\}/);
  });

  test("all three share one base digest", () => {
    expect(new Set(apps.map((app) => basePins[app].pin)).size).toBe(1);
  });

  test.each(apps)("%s installs from the frozen lockfile", (app) => {
    expect(basePins[app].source).toMatch(
      /bun install --frozen-lockfile --production/,
    );
  });

  test("only the worker carries the Agent SDK", () => {
    expect(basePins.worker.source).toContain("resolvePinnedClaudeExecutable");
    for (const app of ["api", "scheduler"] as const) {
      expect(basePins[app].source).toContain(
        "test ! -e node_modules/@anthropic-ai",
      );
    }
  });
});

describe("compose and workflow agree with the Dockerfiles", () => {
  const compose = read("infra/docker-compose.yml");

  test.each(apps)("compose builds %s from apps/%s/Dockerfile", (app) => {
    expect(compose).toContain(`dockerfile: apps/${app}/Dockerfile`);
  });

  test("the scheduler alone mounts the Docker socket", () => {
    const mounts = compose.match(/\/var\/run\/docker\.sock:/g) ?? [];
    expect(mounts).toHaveLength(1);
    const schedulerBlock = compose.slice(compose.indexOf("\n  scheduler:"));
    expect(schedulerBlock).toContain("/var/run/docker.sock:");
  });

  test("images.yml builds every app and pushes only on tags", () => {
    const workflow = read(".github/workflows/images.yml");
    expect(workflow).toContain("app: [api, worker, scheduler]");
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain('if [ "$' + '{GITHUB_REF_TYPE}" = tag ]');
    expect(workflow).toContain(
      "push: $" + "{{ steps.meta.outputs.push == 'true' }}",
    );
  });
});

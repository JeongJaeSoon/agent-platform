import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS } from "@agent-platform/platform";
import { DEFAULT_MAX_GIT_MEMORY_BYTES } from "@agent-platform/storage";

// What the image definitions promise without a daemon: every app Dockerfile
// pins one and the same base digest, compose points at files that exist, and
// the images workflow builds every app compose runs. Building and smoking the
// images is images.yml's job.

const root = join(import.meta.dir, "..");
const apps = ["control-host", "worker"] as const;
const EXAMPLE_ENV_PATH = ".env.example";
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
    for (const app of ["control-host"] as const) {
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

  test("one service builds the shared control-host image", () => {
    // Two services building one tag race on export: "already exists".
    expect(
      compose.match(/dockerfile: apps\/control-host\/Dockerfile/g),
    ).toHaveLength(1);
    const schedulerBlock = compose.slice(compose.indexOf("\n  scheduler:"));
    expect(schedulerBlock).toContain(
      "image: $" + "{API_IMAGE:-agent-platform-control-host:dev}",
    );
  });

  test("the scheduler loop surfaces persistent failure", () => {
    const schedulerBlock = compose.slice(compose.indexOf("\n  scheduler:"));
    expect(schedulerBlock).toContain("SCHEDULER_MAX_CONSECUTIVE_FAILURES");
    expect(schedulerBlock).toMatch(/exit 1/);
    // A hung pass must count as a failure; unhealthy alone never restarts.
    expect(schedulerBlock).toContain("timeout -k 10");
    expect(schedulerBlock).toContain("touch /tmp/scheduler-last-ok");
    expect(schedulerBlock).toContain("find /tmp/scheduler-last-ok -newermt");
  });

  test("env example names the variables the scheduler actually reads", () => {
    const example = read(EXAMPLE_ENV_PATH);
    expect(example).not.toContain("WORKER_MEM_LIMIT");
    expect(example).toContain("WORKER_MEMORY_MB=");
    expect(compose).toContain(
      "WORKER_MEMORY_MB: $" + "{WORKER_MEMORY_MB:-2048}",
    );
    // The local daemon has no project quota; the opt-out must be explicit.
    expect(compose).toContain(
      "EXECUTION_WORKSPACE_QUOTA: $" + "{EXECUTION_WORKSPACE_QUOTA:-off}",
    );
  });

  const apiBlock = compose.slice(
    compose.indexOf("\n  api:"),
    compose.indexOf("\n  worker:"),
  );

  test("the API image itself runs under an init that reaps the git helpers it orphans", () => {
    // In the image, not compose, so `docker run` and other orchestrators get
    // it too; image-smoke.sh checks the running container.
    expect(basePins["control-host"].source).toMatch(
      /^ENTRYPOINT \["\/usr\/bin\/tini", "-s", "--", "\/usr\/local\/bin\/docker-entrypoint\.sh"\]$/m,
    );
    expect(basePins["control-host"].source).toMatch(
      /apt-get install .*\btini\b/,
    );
  });

  test("the API's memory limit and git cap are set side by side", () => {
    expect(apiBlock).toContain("mem_limit: $" + "{API_MEMORY_MB:-7168}m");
    expect(apiBlock).toContain(
      "CHECKPOINT_GIT_MEMORY_MB: $" + "{CHECKPOINT_GIT_MEMORY_MB:-1536}",
    );
    // The budget comment in compose is arithmetic over these two defaults.
    expect(DEFAULT_MAX_GIT_MEMORY_BYTES).toBe(1536 * 1024 * 1024);
    expect(DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS).toBe(2);
    const example = read(EXAMPLE_ENV_PATH);
    expect(example).toContain("API_MEMORY_MB=7168");
    expect(example).toContain("CHECKPOINT_GIT_MEMORY_MB=1536");
  });

  test("the scheduler alone mounts the Docker socket", () => {
    const mounts = compose.match(/\/var\/run\/docker\.sock:/g) ?? [];
    expect(mounts).toHaveLength(1);
    const schedulerBlock = compose.slice(compose.indexOf("\n  scheduler:"));
    expect(schedulerBlock).toContain("/var/run/docker.sock:");
  });

  test("images.yml builds every app and pushes only on tags", () => {
    const workflow = read(".github/workflows/images.yml");
    expect(workflow).toContain("app: [control-host, worker]");
    expect(workflow).toContain('tags: ["v*"]');
    // The PR-facing job never pushes and never holds package write; only
    // the tag-gated job does.
    const [buildJob, publishJob] = workflow.split("\n  publish:\n");
    expect(buildJob).toContain("push: false");
    expect(buildJob).not.toContain("packages: write");
    // `workflow_dispatch` may name any ref, tags included, so the event is
    // part of the gate, and only a v* tag qualifies.
    expect(publishJob).not.toContain("github.ref_type == 'tag'");
    expect(publishJob).toContain(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    // Version tags appear only in `promote`, after every staged digest
    // passed its smoke; a rerun on a different digest is refused.
    const promoteJob = publishJob.slice(publishJob.indexOf("\n  promote:\n"));
    expect(
      publishJob.slice(0, publishJob.indexOf("\n  promote:\n")),
    ).not.toContain('GITHUB_REF_NAME}"');
    expect(promoteJob).toContain("docker buildx imagetools create");
    expect(promoteJob).toContain("refusing to move it");
    expect(promoteJob).toContain("after promotion");
    // A single-manifest source must be retagged as is, not wrapped in an
    // index whose digest differs from the staged one.
    expect(promoteJob).toContain("imagetools create --prefer-index=false");
    // Promotions serialize repository-wide; the tag check is not atomic.
    expect(promoteJob).toContain("group: images-promote");
    expect(promoteJob).toContain("cancel-in-progress: false");
    // A lookup that fails for any reason but "not found" must abort, not
    // read as "tag absent".
    expect(promoteJob).toContain("could not look up");
    expect(promoteJob).not.toMatch(/imagetools inspect[^\n]*\|\| true/);
    expect(publishJob).toContain("packages: write");
    expect(publishJob).toContain("push: true");
    expect(publishJob).toContain("environment: release");
    expect(publishJob).toContain("git merge-base --is-ancestor");
    // Both jobs smoke through the same script; publish smokes what it pushed.
    expect(buildJob).toContain(".github/scripts/image-smoke.sh");
    expect(publishJob).toContain(
      'image-smoke.sh "$APP" "$' + "{NAME}@$" + '{DIGEST}"',
    );
  });

  test("the API is bound to loopback and authenticated in compose", () => {
    expect(compose).toContain('- "127.0.0.1:3000:3000"');
    // Workers reach api:3000 through the proxy; `none` would let them pick
    // any owner with X-Owner-Id.
    expect(compose).toContain("AUTH_MODE: $" + "{AUTH_MODE:-api-key}");
    // `up` runs migrate, so no service may take an ambient DATABASE_URL.
    expect(compose).not.toMatch(/\$\{DATABASE_URL/);
  });
});

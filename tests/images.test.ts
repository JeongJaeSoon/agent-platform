import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_CONCURRENT_BUNDLE_VERIFICATIONS } from "@agent-platform/platform";
import { DEFAULT_MAX_GIT_MEMORY_BYTES } from "@agent-platform/storage";
import {
  SHUTDOWN_CLOSE_MS,
  SHUTDOWN_DRAIN_MS,
} from "../apps/control-host/src/api/shutdown.ts";

// What the image definitions promise without a daemon: every app Dockerfile
// pins one and the same base digest, compose points at files that exist, and
// the images workflow builds every app compose runs. Building and smoking the
// images is images.yml's job.

const root = join(import.meta.dir, "..");
const apps = ["control-host", "worker", "egress-proxy"] as const;
/** The apps with a workspace install; the egress proxy imports nothing. */
const installingApps = ["control-host", "worker"] as const;
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
    expect(froms.length).toBeGreaterThan(0);
    for (const line of froms) expect(line).toMatch(/^FROM \$\{BUN_IMAGE\}/);
  });

  test("all of them share one base digest", () => {
    expect(new Set(apps.map((app) => basePins[app].pin)).size).toBe(1);
  });

  test.each(installingApps)("%s installs from the frozen lockfile", (app) => {
    expect(basePins[app].source).toMatch(
      /bun install --frozen-lockfile --production/,
    );
  });

  test("the egress proxy image copies only its own code, which needs no install", () => {
    // The Dockerfile has no `bun install`; a dependency added to the proxy
    // must add one (and the deps stage the other apps have) with it.
    const manifest = JSON.parse(read("apps/egress-proxy/package.json"));
    expect(manifest.dependencies ?? {}).toEqual({});
    const source = basePins["egress-proxy"].source;
    expect(source).not.toMatch(/^RUN /m);
    expect(source.match(/^COPY .*$/gm)).toEqual([
      "COPY apps/egress-proxy/package.json ./",
      "COPY apps/egress-proxy/src ./src",
    ]);
    expect(source).toMatch(/^USER 1000:1000$/m);
  });

  // The scheduler runs the worker image as the workspace inode helper
  // (94S-224); image-smoke.sh runs the tools themselves.
  test("the worker carries xfsprogs for the inode helper", () => {
    expect(basePins.worker.source).toMatch(/apt-get install .*\bxfsprogs\b/);
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

  test("compose gives the API longer to stop than its drain takes", () => {
    const apiBlock = compose.slice(compose.indexOf("\n  api:"));
    const graceSeconds = Number(
      apiBlock.match(/^ {4}stop_grace_period: (\d+)s$/m)?.[1],
    );
    expect(graceSeconds * 1000).toBeGreaterThan(
      SHUTDOWN_DRAIN_MS + SHUTDOWN_CLOSE_MS,
    );
  });

  test("no two services build the same image tag", () => {
    // Two builds exporting one tag race: "image ... already exists".
    const { services } = Bun.YAML.parse(compose) as {
      services: Record<string, { build?: unknown; image?: string }>;
    };
    const built = Object.values(services)
      .filter((service) => service.build && service.image)
      .map((service) => service.image);
    expect(new Set(built).size).toBe(built.length);
    expect(services.scheduler?.build).toBeUndefined();
    expect(services.scheduler?.image).toBe(services.api?.image);
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

  const reconcilerBlock = compose.slice(
    compose.indexOf("\n  reconciler:"),
    compose.indexOf("\nnetworks:"),
  );

  test("the scheduler alone mounts the Docker socket", () => {
    const mounts = compose.match(/\/var\/run\/docker\.sock:/g) ?? [];
    expect(mounts).toHaveLength(1);
    const schedulerBlock = compose.slice(
      compose.indexOf("\n  scheduler:"),
      compose.indexOf("\n  reconciler:"),
    );
    expect(schedulerBlock).toContain("/var/run/docker.sock:");
    // The reconciler records intent in the database; the scheduler acts on
    // it (94S-320). Neither a mount nor a DOCKER_HOST gives it the daemon.
    expect(reconcilerBlock).not.toContain("docker.sock");
    expect(reconcilerBlock).not.toContain("DOCKER_HOST");
    expect(reconcilerBlock).not.toMatch(/^ {4}volumes:/m);
  });

  test("the reconciler runs by default as a supervised loop in the apps profile", () => {
    expect(reconcilerBlock.length).toBeGreaterThan(0);
    expect(reconcilerBlock).toContain('profiles: ["apps"]');
    // It runs the image the api service builds rather than building the
    // same tag a second time, which races the api build on export.
    const { api, reconciler } = composeServices("infra/docker-compose.yml");
    expect(api?.build?.dockerfile).toBe("apps/control-host/Dockerfile");
    expect(reconciler?.build).toBeUndefined();
    expect(reconciler?.image).toBe(api?.image);
    expect(reconcilerBlock).toContain(
      'command: ["bun", "run", "apps/control-host/src/reconciler/loop.ts"]',
    );
    expect(reconcilerBlock).toContain("restart: unless-stopped");
    expect(reconcilerBlock).toContain(
      'test: ["CMD", "bun", "run", "apps/control-host/src/reconciler/health.ts"]',
    );
    for (const name of [
      "RECONCILER_INTERVAL_SEC",
      "RECONCILER_PASS_TIMEOUT_SEC",
      "RECONCILER_MAX_CONSECUTIVE_FAILURES",
      "RECONCILER_HEALTH_STALE_SEC",
    ]) {
      expect(reconcilerBlock).toContain(`${name}: $` + `{${name}:-`);
    }
    // It refuses to start with HEARTBEAT_TTL_SEC set, which an env file
    // shared with the API would hand it; nor does it listen on anything.
    expect(reconcilerBlock).not.toContain("env_file");
    expect(reconcilerBlock).not.toContain("HEARTBEAT_TTL_SEC:");
    expect(reconcilerBlock).not.toMatch(/^ {4}ports:/m);
  });

  test("images.yml builds every app and pushes only on tags", () => {
    const workflow = read(".github/workflows/images.yml");
    expect(workflow).toContain("app: [control-host, worker, egress-proxy]");
    expect(workflow).toContain('test "$(ls staged/*.json | wc -l)" -eq 3');
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

type ComposeService = {
  image?: string;
  build?: { dockerfile?: string };
  ports?: (string | { host_ip?: string })[];
  volumes?: string[];
};

const composeServices = (path: string) =>
  (Bun.YAML.parse(read(path)) as { services: Record<string, ComposeService> })
    .services;

describe("compose publishes nothing beyond loopback and runs pinned images (94S-323)", () => {
  const services = composeServices("infra/docker-compose.yml");
  const restore = composeServices("infra/docker-compose.restore.yml");

  test.each([
    ["docker-compose.yml", services],
    ["docker-compose.restore.yml", restore],
  ] as const)("every published port in %s is bound to 127.0.0.1", (_, file) => {
    const published = Object.entries(file).flatMap(([name, service]) =>
      (service.ports ?? []).map((port) => [name, port] as const),
    );
    expect(published.length).toBeGreaterThan(0);
    for (const [name, port] of published) {
      // `a:b` and a bare `b` bind every interface, as does a long-syntax
      // entry without host_ip.
      const bound =
        typeof port === "string"
          ? port.startsWith("127.0.0.1:")
          : port.host_ip === "127.0.0.1";
      expect({ name, port, bound }).toEqual({ name, port, bound: true });
    }
  });

  test("only what a host-side process uses is published", () => {
    const published = Object.fromEntries(
      Object.entries(services)
        .filter(([, service]) => service.ports?.length)
        .map(([name, service]) => [name, service.ports]),
    );
    expect(published).toEqual({
      postgres: ["127.0.0.1:5432:5432"],
      localstack: ["127.0.0.1:4566:4566"],
      secrets: ["127.0.0.1:4567:4566"],
      gitea: ["127.0.0.1:3001:3000"],
      api: ["127.0.0.1:3000:3000"],
    });
  });

  test("every image is built here or pinned by index digest", () => {
    const builtImages = new Set(
      Object.values(services)
        .filter((service) => service.build)
        .map((service) => service.image),
    );
    for (const [name, service] of Object.entries(services)) {
      if (service.build) {
        // Built images are released by digest through images.yml.
        const app = service.build.dockerfile?.match(
          /^apps\/([^/]+)\/Dockerfile$/,
        )?.[1];
        expect({ name, app }).toEqual({
          name,
          app: expect.stringMatching(/./),
        });
        expect(apps).toContain(app as (typeof apps)[number]);
        continue;
      }
      if (builtImages.has(service.image)) continue;
      expect({ name, image: service.image }).toEqual({
        name,
        image: expect.stringMatching(/^[^@\s]+@sha256:[0-9a-f]{64}$/),
      });
    }
  });

  test("compose runs Bun from the digest the Dockerfiles pin", () => {
    const bunImages = Object.values(services)
      .map((service) => service.image)
      .filter((image) => image?.startsWith("oven/bun:"));
    expect(bunImages.length).toBeGreaterThan(0);
    for (const image of bunImages)
      expect(image).toBe(basePins["control-host"].pin);
  });

  test("the egress proxy runs its released image, not a mounted source tree", () => {
    const proxy = services["egress-proxy"];
    expect(proxy?.build?.dockerfile).toBe("apps/egress-proxy/Dockerfile");
    expect(proxy?.image).toBe(
      "$" + "{EGRESS_PROXY_IMAGE:-agent-platform-egress-proxy:dev}",
    );
    expect(proxy?.volumes).toBeUndefined();
  });
});

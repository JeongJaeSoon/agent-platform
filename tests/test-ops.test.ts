import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucketHoldsObjectVersion } from "@agent-platform/storage";
import {
  createMemoryCheckpointObjectStore,
  localstackEnabled,
  withLocalstackBucket,
} from "@agent-platform/testkit";
import { PutBucketEncryptionCommand } from "@aws-sdk/client-s3";
import {
  catalogRevision,
  checkRender,
  decideUpgrade,
  type ObjectStoreMode,
  parseReleaseManifest,
  probeRoundTrip,
  probeStore,
  type RenderedModel,
} from "../scripts/lib/test-ops.ts";
import { TEST_OPS_LAYERS, TEST_OPS_STORE_LAYERS } from "./compose-layers.ts";

/**
 * scripts/test-ops.sh without a daemon (94S-432): its argument and settings
 * refusals, and the checks of scripts/lib/test-ops.ts it runs — the release
 * manifest, the rendered installation, the bucket round trip and the
 * upgrade gate. Deploying, upgrading, backing up and reseeding a running
 * installation need a host with Docker; that rehearsal is 94S-434's, and
 * the s3 store on a real AWS account 94S-303's.
 */

const repoRoot = join(import.meta.dir, "..");
const script = join(repoRoot, "scripts/test-ops.sh");
const EXAMPLE_MANIFEST = join(repoRoot, "infra/test-ops.release.example.json");

async function run(args: string[], env: Record<string, string>) {
  const handle = Bun.spawn(["bash", script, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
    new Response(handle.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("scripts/test-ops.sh", () => {
  let dir: string;
  let env: Record<string, string>;
  let calls: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "test-ops-"));
    calls = join(dir, "docker-calls");
    await mkdir(join(dir, "bin"));
    // Any docker call is recorded and fails: none of these cases may reach it.
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`,
      { mode: 0o755 },
    );
    await writeFile(join(dir, "settings"), "EXECUTION_INSTALLATION_ID=t\n", {
      mode: 0o600,
    });
    env = {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
      TEST_OPS_ENV_FILE: join(dir, "settings"),
      TEST_OPS_STATE_DIR: join(dir, "state"),
    };
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const dockerCalls = () => readFile(calls, "utf8").catch(() => "");

  test("parses as bash", () => {
    expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  });

  test.each([
    [[]],
    [["launch"]],
    [["deploy"]],
    [["deploy", "a.json", "b.json"]],
    [["upgrade"]],
    [["upgrade", "a.json", "--approve"]],
    [["upgrade", "a.json", "--approve-sessions"]],
    [["status", "extra"]],
    [["backup", "--now"]],
    [["backup", "--stop", "--now"]],
    [["key"]],
    [["reseed"]],
    [["reseed", "backups/b", "backups/c"]],
    [["reset"]],
    [["reset", "--force"]],
    [["restore-drill", "--bucket", "drill"]],
    [["restore-drill", "backups/b", "--bucket", "drill", "--port-base", "x"]],
    [["restore-drill", "backups/b", "backups/c", "--bucket", "drill"]],
  ])("refuses %j with usage, touching nothing", async (args) => {
    const result = await run(args, env);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("scripts/test-ops.sh preflight");
    expect(await dockerCalls()).toBe("");
  });

  test("refuses the local stack's project name", async () => {
    const result = await run(["status"], {
      ...env,
      TEST_OPS_PROJECT: "agent-platform",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("is the local stack's project");
    expect(await dockerCalls()).toBe("");
  });

  test("needs its env file", async () => {
    const result = await run(["status"], {
      ...env,
      TEST_OPS_ENV_FILE: join(dir, "missing"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `env file ${join(dir, "missing")} not found`,
    );
    expect(await dockerCalls()).toBe("");
  });

  test.each([0o640, 0o604, 0o620])(
    "refuses an env file with mode %o",
    async (mode) => {
      await chmod(join(dir, "settings"), mode);
      const result = await run(["status"], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("open to group or others; chmod 600 it");
      expect(await dockerCalls()).toBe("");
    },
  );

  test("hands the env file to compose and never sources it", async () => {
    const source = await readFile(script, "utf8");
    expect(source).toContain('--env-file "$ENV_FILE"');
    expect(source).not.toMatch(/^\s*(source|\.)\s+"?\$\{?ENV_FILE/m);
  });

  test("refuses a manifest naming an image by tag", async () => {
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    manifest.images.worker = "ghcr.io/jeongjaesoon/agent-platform-worker:v1";
    await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
    const result = await run(["preflight", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "images.worker must be <name>@sha256:<64 hex>",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("preflight refuses a checkout that is not the manifest's source commit", async () => {
    const result = await run(["preflight", EXAMPLE_MANIFEST], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the manifest's source_commit is 0123456789abcdef0123456789abcdef01234567; check that commit out first",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("preflight refuses a Docker Engine older than 28", async () => {
    const head = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"])
      .stdout.toString()
      .trim();
    const dirty = Bun.spawnSync([
      "git",
      "-C",
      repoRoot,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]).stdout.toString();
    // The checkout check comes first; a working tree with edits stops there.
    if (dirty !== "") return;
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    manifest.source_commit = head;
    await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho "$*" >> "${calls}"\n[ "$1" = version ] && { echo 27.5.1; exit 0; }\nexit 1\n`,
      { mode: 0o755 },
    );
    const result = await run(["preflight", join(dir, "release.json")], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Docker Engine 27.5.1 is too old");
  });

  test("refuses an object store it does not know", async () => {
    const result = await run(["status"], {
      ...env,
      TEST_OPS_OBJECT_STORE: "gcs",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "TEST_OPS_OBJECT_STORE must be localstack or s3, not 'gcs'",
    );
    expect(await dockerCalls()).toBe("");
  });

  test("keeps the object store deploy recorded", async () => {
    await mkdir(join(dir, "state"));
    await writeFile(
      join(dir, "state", "installation"),
      "project=agent-platform-test-ops\ninstallation=test-ops\nobject_store=localstack",
    );
    const result = await run(["status"], {
      ...env,
      TEST_OPS_OBJECT_STORE: "s3",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "the installation was deployed on localstack; moving it to s3 is a reset and a new deploy",
    );
    expect(await dockerCalls()).toBe("");
  });

  test.each([
    ["localstack", ["--bucket", "drill"], "drop --bucket"],
    ["s3", [], "restore-drill on s3 needs --bucket"],
  ])("restore-drill on %s refuses %j", async (store, extra, message) => {
    const result = await run(["restore-drill", "backups/b", ...extra], {
      ...env,
      TEST_OPS_OBJECT_STORE: store,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
    expect(await dockerCalls()).toBe("");
  });

  test("status needs a deployed release", async () => {
    const result = await run(["status"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no release is deployed");
  });

  // The provider key rotation in docs/test-ops.md: the deployed release again,
  // worker unchanged, so nothing is approved (94S-434 found it dying under
  // `set -u` and leaving pending.json behind).
  test("upgrade to the same worker image needs no approval", async () => {
    const manifest = JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8"));
    await mkdir(join(dir, "state"));
    await writeFile(
      join(dir, "state", "current.json"),
      JSON.stringify(manifest),
    );
    await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
    await writeFile(
      join(dir, "state", "installation"),
      "project=agent-platform-test-ops\ninstallation=t\nobject_store=localstack",
    );
    const render = JSON.stringify({
      services: {
        postgres: {
          environment: { POSTGRES_DB: "sessions", POSTGRES_USER: "postgres" },
        },
        scheduler: { environment: { EXECUTION_INSTALLATION_ID: "t" } },
      },
    });
    const stubs: Record<string, string> = {
      // No uncollected checkpoint; every compose call but config succeeds.
      docker: `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  version*) echo 28.0.4 ;;
  "compose version --short") echo 2.38.2 ;;
  *" config --format json") echo '${render}' ;;
esac
exit 0
`,
      git: `#!/bin/sh\ncase "$*" in *rev-parse*) echo ${manifest.source_commit} ;; esac\nexit 0\n`,
      curl: `#!/bin/sh\necho '{"status":"ready"}'\n`,
      // check-render needs the whole installation; the rest is the real helper.
      bun: `#!/bin/sh\ncase "$*" in *check-render*) exit 0 ;; esac\nexec "${process.execPath}" "$@"\n`,
    };
    for (const [name, body] of Object.entries(stubs))
      await writeFile(join(dir, "bin", name), body, { mode: 0o755 });

    const result = await run(["upgrade", join(dir, "release.json")], env);
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("upgrade: done");
    expect(await dockerCalls()).toContain("up -d --wait");
    expect(
      await readFile(join(dir, "state", "pending.json"), "utf8").catch(
        () => null,
      ),
    ).toBeNull();
  });
});

describe("release manifest", () => {
  test("the example parses", async () => {
    const manifest = parseReleaseManifest(
      JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8")),
    );
    expect(manifest.images.worker).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  const base = async () =>
    JSON.parse(await readFile(EXAMPLE_MANIFEST, "utf8")) as {
      images: Record<string, unknown>;
      [key: string]: unknown;
    };

  test.each([
    ["control_host", "ghcr.io/jeongjaesoon/agent-platform-control-host:latest"],
    ["worker", "ghcr.io/jeongjaesoon/agent-platform-worker"],
    ["egress_proxy", `ghcr.io/x/egress-proxy@sha256:${"a".repeat(63)}`],
    ["worker", `ghcr.io/x/worker@sha512:${"a".repeat(64)}`],
    ["worker", 7],
  ])("refuses images.%s = %p", async (key, value) => {
    const manifest = await base();
    manifest.images[key] = value;
    expect(() => parseReleaseManifest(manifest)).toThrow(
      `images.${key} must be <name>@sha256:<64 hex>`,
    );
  });

  test.each([
    ["source_commit", "main", "source_commit must be a full 40-hex commit"],
    ["source_commit", "0123456", "source_commit must be a full 40-hex commit"],
    ["catalog_revision", "v3", "catalog_revision must be sha256:<64 hex>"],
    ["tag", "v1", "manifest has unknown key tag"],
  ])("refuses %s = %p", async (key, value, message) => {
    const manifest = await base();
    manifest[key] = value;
    expect(() => parseReleaseManifest(manifest)).toThrow(message);
  });
});

describe("rendered installation", () => {
  let catalog: string;

  beforeEach(async () => {
    catalog = await mkdtemp(join(tmpdir(), "test-ops-catalog-"));
    await writeFile(join(catalog, "profiles.yaml"), "profiles: {}\n");
    await mkdir(join(catalog, "more"));
    await writeFile(
      join(catalog, "more", "repositories.yaml"),
      "repositories: {}\n",
    );
  });

  afterEach(async () => {
    await rm(catalog, { force: true, recursive: true });
  });

  /** The real layers rendered as scripts/test-ops.sh renders them. */
  function render(store: ObjectStoreMode): RenderedModel {
    const { PATH = "", HOME = "" } = Bun.env;
    const digest = (c: string) => `@sha256:${c.repeat(64)}`;
    // Placeholders only: the render never leaves this process.
    const filler = (c: string) => c.repeat(16);
    const result = Bun.spawnSync(
      [
        "docker",
        "compose",
        "--env-file",
        "/dev/null",
        "--profile",
        "apps",
        ...[...TEST_OPS_LAYERS, TEST_OPS_STORE_LAYERS[store]].flatMap(
          (file) => ["-f", join(repoRoot, file)],
        ),
        "config",
        "--format",
        "json",
      ],
      {
        env: {
          PATH,
          HOME,
          API_IMAGE: `ghcr.io/x/control-host${digest("a")}`,
          WORKER_IMAGE: `ghcr.io/x/worker${digest("b")}`,
          EGRESS_PROXY_IMAGE: `ghcr.io/x/egress-proxy${digest("c")}`,
          POSTGRES_PASSWORD: filler("p"),
          EGRESS_AUTHORIZER_TOKEN: filler("t"),
          ...(store === "s3" ? { S3_BUCKET: "ops-bucket" } : {}),
          AWS_ACCESS_KEY_ID: filler("i"),
          AWS_SECRET_ACCESS_KEY: filler("s"),
          ANTHROPIC_API_KEY: filler("k"),
          PLATFORM_CATALOG_DIR: catalog,
          EXECUTION_WORKSPACE_QUOTA: "on",
          EXECUTION_INSTALLATION_ID: "test-ops",
          ...(store === "s3"
            ? {
                EGRESS_CREDENTIAL_ALLOWLIST:
                  "api.anthropic.com:443,ops-bucket.s3.ap-northeast-1.amazonaws.com:443",
                EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "gitea:3000",
              }
            : {
                EGRESS_CREDENTIAL_ALLOWLIST: "api.anthropic.com:443",
                EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST:
                  "gitea:3000,localstack:4566",
              }),
        },
      },
    );
    expect(result.stderr.toString()).toBe("");
    return JSON.parse(result.stdout.toString()) as RenderedModel;
  }

  test.each(["localstack", "s3"] as const)(
    "the test-ops layers on %s pass, and the mounted catalog is what the manifest names",
    async (store) => {
      const revision = await catalogRevision(catalog);
      expect(
        await checkRender(render(store), { catalogRevision: revision, store }),
      ).toBe(revision);
    },
  );

  test("a render is checked against the store it is meant for", async () => {
    await expect(
      checkRender(render("localstack"), { store: "s3" }),
    ).rejects.toThrow("service localstack is local-only");
    await expect(
      checkRender(render("s3"), { store: "localstack" }),
    ).rejects.toThrow("service localstack is missing");
  });

  test("the catalog revision follows every file's path and bytes", async () => {
    const before = await catalogRevision(catalog);
    expect(await catalogRevision(catalog)).toBe(before);
    await writeFile(
      join(catalog, "more", "repositories.yaml"),
      "repositories: {x: 1}\n",
    );
    expect(await catalogRevision(catalog)).not.toBe(before);
  });

  test("reports every way a render is not a test-ops installation", async () => {
    const model = render("s3");
    const services = model.services ?? {};
    const env = (name: string) => {
      const found = services[name]?.environment;
      if (found === undefined) throw new Error(`${name} has no environment`);
      return found;
    };
    services.localstack = { image: "localstack/localstack:3" };
    services.migrate = { ...services.migrate, build: { context: ".." } };
    services.worker = { ...services.worker, image: "ghcr.io/x/worker:v1" };
    services.gitea = {
      ...services.gitea,
      ports: [{ host_ip: "0.0.0.0", published: "3001", target: 3000 }],
    };
    env("api").AUTH_MODE = "none";
    env("api").CHECKPOINT_OBJECT_PROTECTION = "unversioned";
    env("postgres").POSTGRES_PASSWORD = "a/b@c";
    env("scheduler").EXECUTION_WORKSPACE_QUOTA = "off";
    env("scheduler").EXECUTION_INSTALLATION_ID = "local";
    env("egress-proxy").EGRESS_CREDENTIAL_ALLOWLIST = "api.anthropic.com:443";
    env("egress-proxy").EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST =
      "gitea:3000,fake-messages:4010";
    env("api").AWS_ENDPOINT_URL = "http://localstack:4566";
    const found = await checkRender(model, {
      catalogRevision: `sha256:${"0".repeat(64)}`,
      store: "s3",
    }).then(
      () => "",
      (error: Error) => error.message,
    );
    for (const expected of [
      "service localstack is local-only",
      "service migrate builds its image",
      "service worker runs ghcr.io/x/worker:v1, not an image by digest",
      "service gitea publishes 3001 on 0.0.0.0",
      "api AUTH_MODE must be api-key",
      "api CHECKPOINT_OBJECT_PROTECTION must be locked",
      "POSTGRES_PASSWORD may hold only letters, digits and . _ ~ -",
      "EXECUTION_WORKSPACE_QUOTA must be on",
      'EXECUTION_INSTALLATION_ID must name this installation, not "local"',
      "EGRESS_CREDENTIAL_ALLOWLIST must name ops-bucket.s3.ap-northeast-1.amazonaws.com:443",
      "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names fake-messages:4010, a local-only service",
      "api AWS_ENDPOINT_URL must be unset: the store is AWS S3",
      `the manifest says sha256:${"0".repeat(64)}`,
    ])
      expect(found).toContain(expected);
  });

  test("reports every way a render is not a LocalStack test-ops installation", async () => {
    const model = render("localstack");
    const services = model.services ?? {};
    const api = services.api?.environment;
    const proxy = services["egress-proxy"]?.environment;
    if (api === undefined || proxy === undefined)
      throw new Error("api or egress-proxy has no environment");
    services.secrets = {
      image: `localstack/localstack@sha256:${"d".repeat(64)}`,
    };
    api.AWS_ENDPOINT_URL = "http://127.0.0.1:4566";
    api.S3_BUCKET = "ops-bucket";
    proxy.EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST = "gitea:3000,secrets:4566";
    const found = await checkRender(model, { store: "localstack" }).then(
      () => "",
      (error: Error) => error.message,
    );
    for (const expected of [
      "service secrets is local-only",
      "api AWS_ENDPOINT_URL must be http://localstack:4566",
      "S3_BUCKET must be claude-sessions",
      "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST must name localstack:4566",
      "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names secrets:4566, a local-only service",
    ])
      expect(found).toContain(expected);
  });

  test("refuses the checkout's own catalog", async () => {
    const model = render("localstack");
    const volume = model.services?.api?.volumes?.[0];
    if (volume === undefined) throw new Error("api mounts nothing");
    volume.source = join(repoRoot, "config");
    await expect(checkRender(model, { store: "localstack" })).rejects.toThrow(
      "is inside the checkout",
    );
  });
});

describe("bucket round trip", () => {
  test("puts, holds, reads back, releases and deletes, leaving nothing", async () => {
    const store = createMemoryCheckpointObjectStore({ versioned: true });
    await probeRoundTrip({
      collector: store,
      key: "test-ops-preflight/probe",
      objects: store,
    });
    expect(await store.listVersions("test-ops-preflight/")).toEqual([]);
  });

  test("names the permission of the step that failed", async () => {
    const store = createMemoryCheckpointObjectStore({ versioned: true });
    await expect(
      probeRoundTrip({
        collector: store,
        key: "test-ops-preflight/probe",
        objects: {
          ...store,
          hold: async () => {
            throw new Error("Access Denied");
          },
        },
      }),
    ).rejects.toThrow(
      "s3:PutObjectLegalHold on test-ops-preflight/probe failed: Access Denied",
    );
  });

  test("refuses a store that gives no versions", async () => {
    const store = createMemoryCheckpointObjectStore();
    await expect(
      probeRoundTrip({ collector: store, key: "k", objects: store }),
    ).rejects.toThrow("the bucket must be versioned");
  });

  // Off rather than skipped where LocalStack is not configured: an
  // undeclared skip fails the integration job (94S-307).
  (localstackEnabled() ? describe : describe.skip)("on LocalStack", () => {
    const model = (bucket: {
      bucket: string;
      env: { [key: string]: string };
    }): RenderedModel => ({
      services: {
        api: {
          environment: {
            AWS_ACCESS_KEY_ID: bucket.env.accessKeyId ?? null,
            AWS_ENDPOINT_URL: bucket.env.endpoint ?? null,
            AWS_REGION: bucket.env.region ?? null,
            AWS_SECRET_ACCESS_KEY: bucket.env.secretAccessKey ?? null,
            CHECKPOINT_OBJECT_PROTECTION: "locked",
            S3_BUCKET: bucket.bucket,
          },
        },
      },
    });

    test("passes on a locked SSE-S3 bucket and leaves it empty", async () => {
      await withLocalstackBucket(
        async (bucket) => {
          await bucket.s3.send(
            new PutBucketEncryptionCommand({
              Bucket: bucket.bucket,
              ServerSideEncryptionConfiguration: {
                Rules: [
                  {
                    ApplyServerSideEncryptionByDefault: {
                      SSEAlgorithm: "AES256",
                    },
                  },
                ],
              },
            }),
          );
          expect(await probeStore(model(bucket))).toBe(bucket.bucket);
          expect(await bucketHoldsObjectVersion(bucket.s3, bucket.bucket)).toBe(
            false,
          );
        },
        { objectLock: true, prefix: "test-ops-it" },
      );
    });

    test("refuses a bucket without Object Lock", async () => {
      await withLocalstackBucket(
        async (bucket) => {
          await expect(probeStore(model(bucket))).rejects.toThrow(
            "Object Lock not configured",
          );
        },
        { prefix: "test-ops-it" },
      );
    });
  });
});

describe("upgrade gate", () => {
  const from = `ghcr.io/x/worker@sha256:${"a".repeat(64)}`;
  const to = `ghcr.io/x/worker@sha256:${"b".repeat(64)}`;

  test("the same worker image affects nothing", () => {
    expect(
      decideUpgrade({ affected: ["s1"], fromWorker: from, toWorker: from }),
    ).toEqual({ approved: [], proceed: true });
  });

  test("a new worker image with no uncollected checkpoint goes ahead", () => {
    expect(
      decideUpgrade({ affected: [], fromWorker: from, toWorker: to }),
    ).toEqual({ approved: [], proceed: true });
  });

  test("refuses without approval, listing every affected session", () => {
    const verdict = decideUpgrade({
      affected: ["s2", "s1"],
      fromWorker: from,
      toWorker: to,
    });
    expect(verdict.proceed).toBe(false);
    if (verdict.proceed) return;
    expect(verdict.reason).toContain("2 session(s)");
    expect(verdict.reason).toContain("s1\ns2");
  });

  test("goes ahead on exactly the affected sessions, in any order", () => {
    expect(
      decideUpgrade({
        affected: ["s2", "s1"],
        approved: ["s1", "s2", "s1"],
        fromWorker: from,
        toWorker: to,
      }),
    ).toEqual({ approved: ["s1", "s2"], proceed: true });
  });

  test.each([
    [["s1"], "not approved: s2"],
    [["s1", "s2", "s3"], "no longer affected: s3"],
  ])("refuses an approval of %j", (approved, message) => {
    const verdict = decideUpgrade({
      affected: ["s1", "s2"],
      approved,
      fromWorker: from,
      toWorker: to,
    });
    expect(verdict.proceed).toBe(false);
    if (!verdict.proceed) expect(verdict.reason).toContain(message);
  });

  test("the CLI exits 3 on a refusal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "test-ops-gate-"));
    try {
      await writeFile(join(dir, "affected"), "s1\n");
      const result = Bun.spawnSync([
        "bun",
        "run",
        join(repoRoot, "scripts/lib/test-ops.ts"),
        "upgrade-gate",
        from,
        to,
        join(dir, "affected"),
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr.toString()).toContain("upgrade refused");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

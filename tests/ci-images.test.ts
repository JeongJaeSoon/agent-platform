import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MIGRATION_HELPER_IMAGE } from "@agent-platform/execution-local-docker";
import { suiteFiles } from "../.github/scripts/test-files.ts";

// CI pulls third-party images from its ghcr.io mirror only, by digests the
// mirror workflow copies there (94S-308). What ci.yml names must be on that
// list, and every image a suite pulls on its own must be pointed at it.

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const MIRROR = "ghcr.io/jeongjaesoon/agent-platform-ci/";
const MIRROR_REF =
  /^ghcr\.io\/jeongjaesoon\/agent-platform-ci\/([a-z0-9-]+)@(sha256:[0-9a-f]{64})$/;

type Entry = { name: string; source: string; tag: string; digest: string };
type Job = {
  env?: Record<string, unknown>;
  services?: Record<string, { image?: string }>;
  steps?: { env?: Record<string, unknown> }[];
  strategy?: { matrix?: { include?: Entry[] } };
};
type Workflow = { jobs: Record<string, Job> };

const mirrored =
  (Bun.YAML.parse(read(".github/workflows/ci-image-mirror.yml")) as Workflow)
    .jobs.mirror?.strategy?.matrix?.include ?? [];
/** The entry a `<name>@<digest>` mirror reference resolves to, if any. */
const entryOf = (name: string, digest: string | undefined) =>
  mirrored.find((entry) => entry.name === name && entry.digest === digest);
const ciText = read(".github/workflows/ci.yml");
const ci = Bun.YAML.parse(ciText) as Workflow;

/** `docker.io/library/busybox` → `busybox`, as a Docker Hub short name. */
const shortName = (source: string) =>
  source.replace(/^docker\.io\//, "").replace(/^library\//, "");

/** A service image, or the non-empty literal of `matrix.x && '<image>' || ''`. */
const serviceImages = Object.values(ci.jobs).flatMap((job) =>
  Object.values(job.services ?? {}).map(({ image = "" }) => {
    const literal = image.match(/'([^']+)'/)?.[1];
    return literal ?? image;
  }),
);

/** Every `*_IMAGE` variable ci.yml sets, job-level or per step. */
const imageVariables = Object.values(ci.jobs).flatMap((job) =>
  [job.env, ...(job.steps ?? []).map((step) => step.env)].flatMap((env) =>
    Object.entries(env ?? {}).filter(([key]) => key.endsWith("_IMAGE")),
  ),
);

describe("the mirror list", () => {
  test("names each digest once, from Docker Hub", () => {
    expect(mirrored.length).toBeGreaterThan(0);
    // A name may carry two digests while a bump is under way (docs/ci.md § 서드파티 이미지 미러).
    const keys = new Set(
      mirrored.map(({ name, digest }) => `${name}@${digest}`),
    );
    expect(keys.size).toBe(mirrored.length);
    for (const { name, source, tag, digest } of mirrored) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(source).toMatch(/^docker\.io\/[a-z0-9._/-]+$/);
      expect(typeof tag).toBe("string");
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("busybox is the workspace-migration helper, bun the app base", () => {
    const [, helperDigest] = DEFAULT_MIGRATION_HELPER_IMAGE.split("@");
    expect(entryOf("busybox", helperDigest)?.source).toBe(
      "docker.io/library/busybox",
    );
    const dockerfiles = [...new Bun.Glob("apps/*/Dockerfile").scanSync(root)];
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const dockerfile of dockerfiles) {
      const base = read(dockerfile).match(/^ARG BUN_IMAGE=(\S+)$/m)?.[1];
      const bun = entryOf("bun", base?.split("@")[1]);
      expect({ dockerfile, base }).toEqual({
        dockerfile,
        base: `${shortName(bun?.source ?? "")}:${bun?.tag}@${bun?.digest}`,
      });
    }
  });

  test("the inode helper CI builds stands on the worker's base", () => {
    const worker = read("apps/worker/Dockerfile").match(
      /^ARG BUN_IMAGE=\S+@(sha256:[0-9a-f]{64})$/m,
    )?.[1];
    expect(ciText).toContain(`"FROM ${MIRROR}bun@${worker}"`);
  });
});

describe("images.yml", () => {
  // 94S-317: the app builds pull their base and BuildKit from the mirror too.
  type Step = { uses?: string; with?: Record<string, unknown> };
  const imagesText = read(".github/workflows/images.yml");
  const images = Bun.YAML.parse(imagesText) as {
    env: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = (action: string) =>
    Object.values(images.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses?.startsWith(`${action}@`));
  /** `${{ <body> }}`, spelled so the linter does not read a template slot. */
  const expression = (body: string) => `\${{ ${body} }}`;
  const pinned = (variable: string) => {
    const [, name = "", digest] =
      String(images.env[variable]).match(MIRROR_REF) ?? [];
    return { name, entry: entryOf(name, digest) };
  };

  test("builds every app on the Dockerfiles' base, from the mirror", () => {
    const { name, entry } = pinned("BUN_IMAGE");
    expect({ name, mirrored: entry !== undefined }).toEqual({
      name: "bun",
      mirrored: true,
    });
    for (const dockerfile of new Bun.Glob("apps/*/Dockerfile").scanSync(root))
      expect(read(dockerfile)).toContain(`@${entry?.digest}\n`);
    const builds = steps("docker/build-push-action");
    expect(builds.length).toBe(2);
    for (const build of builds)
      expect(build.with?.["build-args"]).toBe(
        `BUN_IMAGE=${expression("env.BUN_IMAGE")}`,
      );
  });

  test("runs BuildKit from the mirror wherever buildx is set up", () => {
    const { name, entry } = pinned("BUILDKIT_IMAGE");
    expect({ name, mirrored: entry !== undefined }).toEqual({
      name: "buildkit",
      mirrored: true,
    });
    const setups = steps("docker/setup-buildx-action");
    expect(setups.length).toBe(3);
    for (const setup of setups)
      expect(setup.with?.["driver-opts"]).toBe(
        `image=${expression("env.BUILDKIT_IMAGE")}`,
      );
  });

  test("names no Docker Hub image", () => {
    for (const { source, tag } of mirrored)
      expect(imagesText).not.toContain(`${shortName(source)}:${tag}`);
    for (const reference of imagesText.match(
      /ghcr\.io\/jeongjaesoon\/agent-platform-ci\/[^\s'"]+/g,
    ) ?? [])
      expect(reference).toMatch(MIRROR_REF);
  });
});

describe("assert-no-docker-hub-images.sh", () => {
  const script = join(root, ".github/scripts/assert-no-docker-hub-images.sh");
  /**
   * Runs the check against a fake daemon: `images` lists one id, and
   * `image inspect` prints `listing` as the RepoDigests of what it holds.
   */
  const daemon =
    'case "$1" in images) echo sha256:1 ;; image) printf "%s" "$LISTING" ;; esac';
  const check = (listing: string, fake = daemon) => {
    const result = Bun.spawnSync(["bash", script, "bash", "-c", fake, "_"], {
      env: { ...process.env, LISTING: listing },
    });
    return { code: result.exitCode, out: result.stdout.toString() };
  };
  const at = `@sha256:${"a".repeat(64)}`;
  const digests = (...names: string[]) =>
    names.map((name) => `${name}${at}`).join("\n");

  test("passes the mirror and the runner's own images", () => {
    const listing = digests(
      `${MIRROR}busybox`,
      `${MIRROR}postgres`,
      "ghcr.io/github/gh-aw-firewall/squid",
      "localhost:5000/scratch",
    );
    expect(check(listing).code).toBe(0);
  });

  test("skips an image built on the daemon, which has no RepoDigests", () => {
    expect(check("").code).toBe(0);
  });

  test("fails on every Docker Hub name, naming it", () => {
    const { code, out } = check(
      digests(
        `${MIRROR}busybox`,
        "alpine",
        "localstack/localstack",
        "docker.io/library/postgres",
        // Looks like the mirror, but without a dot it is a Docker Hub user.
        "ghcr-io/jeongjaesoon/agent-platform-ci/busybox",
      ),
    );
    expect(code).toBe(1);
    for (const name of [
      "alpine",
      "localstack/localstack",
      "docker.io/library/postgres",
      "ghcr-io/jeongjaesoon/agent-platform-ci/busybox",
    ]) {
      expect(out).toContain(`::error::${name} came from Docker Hub`);
    }
    expect(out).not.toContain(`::error::${MIRROR}`);
  });

  test("fails when the daemon cannot be listed", () => {
    expect(check("", "exit 3").code).not.toBe(0);
  });

  test("runs after the tests in every Docker job", () => {
    const steps = (job: string) =>
      JSON.stringify(ci.jobs[job]?.steps ?? []).includes(
        "assert-no-docker-hub-images.sh",
      );
    expect(steps("integration-domain")).toBe(true);
    expect(steps("workspace-quota")).toBe(true);
  });
});

describe("ci.yml", () => {
  test("names no image outside the mirror", () => {
    for (const image of serviceImages)
      expect(image.startsWith(MIRROR)).toBe(true);
    for (const [variable, value] of imageVariables) {
      const image = String(value);
      // Or an image a step builds on the daemon, which nothing pulls.
      const ok = image.startsWith(MIRROR) || ciText.includes(`-t ${image}`);
      expect({ variable, image, ok }).toEqual({ variable, image, ok: true });
    }
    // `docker run` arguments are not parsed; no Docker Hub tag may appear at all.
    for (const { source, tag } of mirrored) {
      expect(ciText).not.toContain(`${shortName(source)}:${tag}`);
    }
  });

  test("pins every mirror reference to the digest the mirror copies", () => {
    const references = ciText.match(/ghcr\.io\/[^\s'"\\]+/g) ?? [];
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const [, name = "", digest] = reference.match(MIRROR_REF) ?? [];
      expect({
        reference,
        mirrored: entryOf(name, digest) !== undefined,
      }).toEqual({
        reference,
        mirrored: true,
      });
    }
  });

  test("hands no suite's migrator the Docker Hub helper directly", () => {
    // The migrator never pulls its helper, so a real daemon in CI has only
    // the mirror's copy. Unit suites with a fake daemon may name it.
    for (const file of suiteFiles(root).filter((file) =>
      file.endsWith(".integration.test.ts"),
    ))
      expect({
        file,
        direct: read(file).includes(
          "helperImage: DEFAULT_MIGRATION_HELPER_IMAGE",
        ),
      }).toEqual({ file, direct: false });
  });

  test("points every image a suite pulls itself at the mirror", () => {
    // variable → its string-literal fallback, if it has one
    const overrides = new Map<string, string | undefined>();
    for (const file of suiteFiles(root)) {
      for (const [, variable = "", fallback] of read(file).matchAll(
        /process\.env\.([A-Z_]+_IMAGE)\b(?:\s*(?:\?\?|\|\|)\s*"([^"]+)")?/g,
      )) {
        if (!overrides.get(variable)) overrides.set(variable, fallback);
      }
    }
    expect([...overrides.keys()]).toContain(
      "EXECUTION_WORKSPACE_MIGRATION_IMAGE",
    );
    const integrationEnv = ci.jobs["integration-domain"]?.env ?? {};
    for (const [variable, fallback] of overrides) {
      const image = String(integrationEnv[variable] ?? "");
      const [, name = "", digest] = image.match(MIRROR_REF) ?? [];
      const entry = entryOf(name, digest);
      expect({ variable, mirrored: entry !== undefined }).toEqual({
        variable,
        mirrored: true,
      });
      // The mirror carries the version the suite runs locally.
      if (fallback && entry) {
        expect(`${shortName(entry.source)}:${entry.tag}`).toBe(fallback);
      }
    }
  });
});

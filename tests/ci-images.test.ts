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
    // A name may carry two digests while a bump is under way (README § CI).
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
    const base = read("apps/api/Dockerfile").match(
      /^ARG BUN_IMAGE=(\S+)$/m,
    )?.[1];
    const bun = entryOf("bun", base?.split("@")[1]);
    expect(base).toBe(
      `${shortName(bun?.source ?? "")}:${bun?.tag}@${bun?.digest}`,
    );
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

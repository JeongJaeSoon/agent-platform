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
const byName = new Map(mirrored.map((entry) => [entry.name, entry]));
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
  test("names each image once, from Docker Hub, by a full digest", () => {
    expect(mirrored.length).toBeGreaterThan(0);
    expect(byName.size).toBe(mirrored.length);
    for (const { name, source, tag, digest } of mirrored) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      expect(source).toMatch(/^docker\.io\/[a-z0-9._/-]+$/);
      expect(typeof tag).toBe("string");
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("busybox is the workspace-migration helper, bun the app base", () => {
    const busybox = byName.get("busybox");
    expect(`busybox@${busybox?.digest}`).toBe(DEFAULT_MIGRATION_HELPER_IMAGE);
    const base = read("apps/api/Dockerfile").match(
      /^ARG BUN_IMAGE=(\S+)$/m,
    )?.[1];
    const bun = byName.get("bun");
    expect(base).toBe(
      `${shortName(bun?.source ?? "")}:${bun?.tag}@${bun?.digest}`,
    );
  });
});

describe("ci.yml", () => {
  test("names no image outside the mirror", () => {
    for (const image of serviceImages)
      expect(image.startsWith(MIRROR)).toBe(true);
    for (const [, image] of imageVariables)
      expect(String(image).startsWith(MIRROR)).toBe(true);
    // `docker run` arguments are not parsed; no Docker Hub tag may appear at all.
    for (const { source, tag } of mirrored) {
      expect(ciText).not.toContain(`${shortName(source)}:${tag}`);
    }
  });

  test("pins every mirror reference to the digest the mirror copies", () => {
    const references = ciText.match(/ghcr\.io\/[^\s'"\\]+/g) ?? [];
    expect(references.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const reference of references) {
      const [, name = "", digest] = reference.match(MIRROR_REF) ?? [];
      expect({ reference, digest: byName.get(name)?.digest }).toEqual({
        reference,
        digest,
      });
      used.add(name);
    }
    // An entry nothing pulls is a copy nobody refreshes on purpose.
    expect([...byName.keys()].filter((name) => !used.has(name))).toEqual([]);
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
      const [, name = ""] = image.match(MIRROR_REF) ?? [];
      const entry = byName.get(name);
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

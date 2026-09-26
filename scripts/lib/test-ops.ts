/**
 * The checks behind scripts/test-ops.sh (94S-432):
 *
 *   bun run scripts/lib/test-ops.ts manifest <release.json>
 *   bun run scripts/lib/test-ops.ts catalog-revision <dir>
 *   bun run scripts/lib/test-ops.ts check-render --store <localstack|s3> [--catalog-revision <rev>] < rendered.json
 *   bun run scripts/lib/test-ops.ts probe-store < rendered.json
 *   bun run scripts/lib/test-ops.ts upgrade-impact <verify-exit> <verify-output> <uncollected>
 *   bun run scripts/lib/test-ops.ts upgrade-gate <from-worker> <to-worker> <affected> [<approved>]
 *
 * rendered.json is `docker compose config --format json` of the test-ops
 * installation: what its containers get, read from the env file by compose
 * itself. Nothing here reads the env file.
 *
 * Exit 2 on usage, 3 when upgrade-gate refuses, 1 on anything else.
 */

import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { CheckpointObjectCollector } from "@agent-platform/platform";
import type { CheckpointObjectStore } from "@agent-platform/runtime-core";
import {
  createCheckpointObjectCollector,
  createCheckpointObjectStore,
  createStorageS3Client,
} from "@agent-platform/storage";
import {
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  checkpointStorageConfigFromEnv,
} from "../../apps/control-host/src/api/checkpoints.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
export const EXIT_REFUSED = 3;

/** A reference compose and the daemon resolve to one set of bytes. */
export const PINNED_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;

/** What compose.local.yml runs and a test-ops installation must not. */
const LOCAL_ONLY = ["localstack", "secrets", "fake-messages", "gitea-init"];

/**
 * Where a test-ops installation keeps checkpoint objects: LocalStack, in
 * memory, while no AWS account is in use (2026-09-25), or AWS S3 itself.
 */
export type ObjectStoreMode = "localstack" | "s3";
export const OBJECT_STORE_MODES: readonly ObjectStoreMode[] = [
  "localstack",
  "s3",
];

/** The bucket infra/localstack/init creates, and the endpoint the API uses. */
const LOCALSTACK_BUCKET = "claude-sessions";
const LOCALSTACK_ENDPOINT = "http://localstack:4566";

/** RFC 3986 unreserved: survives inside the compose-built DATABASE_URL. */
const URL_SAFE = /^[A-Za-z0-9._~-]+$/;

export type ReleaseManifest = {
  readonly catalogRevision: string;
  readonly images: {
    readonly controlHost: string;
    readonly egressProxy: string;
    readonly worker: string;
  };
  readonly sourceCommit: string;
};

/**
 * A release as test-ops deploys it: the commit its compose files come from,
 * the three app images by digest, and the catalog by content. A tag can be
 * moved after the fact; none of these can.
 */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const problems: string[] = [];
  const object = (found: unknown, where: string, keys: readonly string[]) => {
    if (typeof found !== "object" || found === null || Array.isArray(found)) {
      problems.push(`${where} must be an object`);
      return {} as Record<string, unknown>;
    }
    for (const key of Object.keys(found))
      if (!keys.includes(key)) problems.push(`${where} has unknown key ${key}`);
    return found as Record<string, unknown>;
  };
  const text = (
    found: unknown,
    where: string,
    pattern: RegExp,
    what: string,
  ) => {
    if (typeof found === "string" && pattern.test(found)) return found;
    problems.push(`${where} must be ${what}, not ${JSON.stringify(found)}`);
    return "";
  };
  const top = object(value, "manifest", [
    "source_commit",
    "images",
    "catalog_revision",
  ]);
  const images = object(top.images, "images", [
    "control_host",
    "worker",
    "egress_proxy",
  ]);
  const image = (key: string) =>
    text(images[key], `images.${key}`, PINNED_IMAGE, "<name>@sha256:<64 hex>");
  const manifest = {
    catalogRevision: text(
      top.catalog_revision,
      "catalog_revision",
      /^sha256:[0-9a-f]{64}$/,
      "sha256:<64 hex>",
    ),
    images: {
      controlHost: image("control_host"),
      egressProxy: image("egress_proxy"),
      worker: image("worker"),
    },
    sourceCommit: text(
      top.source_commit,
      "source_commit",
      /^[0-9a-f]{40}$/,
      "a full 40-hex commit",
    ),
  };
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return manifest;
}

/**
 * The catalog directory by content: sha256 over each regular file's path and
 * sha256, in path order. What the API mounts is what the manifest names.
 */
export async function catalogRevision(dir: string): Promise<string> {
  const entries: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        entries.push(`${relative(dir, path)}\0${digest}\n`);
      } else
        throw new Error(`catalog ${path} is neither a file nor a directory`);
    }
  };
  await walk(dir);
  const hash = createHash("sha256");
  for (const entry of entries.sort()) hash.update(entry);
  return `sha256:${hash.digest("hex")}`;
}

type RenderedService = {
  build?: unknown;
  environment?: Record<string, string | null>;
  image?: string;
  ports?: { host_ip?: string; published?: string; target?: number }[];
  volumes?: { source?: string; target?: string }[];
};
export type RenderedModel = { services?: Record<string, RenderedService> };

/**
 * Refuses a render that is not a test-ops installation: one that runs or
 * builds a local dependency, names an image by tag, publishes beyond
 * loopback, loosens the API's modes, builds a DSN a password breaks, points
 * the API at another object store than `store`, leaves workers without a
 * route to it, runs workspaces without quota, or mounts a catalog other than
 * the manifest's. Every problem is reported at once. Returns the mounted
 * catalog's revision.
 */
export async function checkRender(
  model: RenderedModel,
  options: {
    readonly catalogRevision?: string;
    readonly store: ObjectStoreMode;
  },
): Promise<string> {
  const services = model.services ?? {};
  const problems: string[] = [];
  const env = (service: string, name: string) =>
    services[service]?.environment?.[name] ?? undefined;
  const localOnly = LOCAL_ONLY.filter(
    (name) => !(options.store === "localstack" && name === "localstack"),
  );
  for (const name of localOnly)
    if (name in services) problems.push(`service ${name} is local-only`);
  for (const [name, service] of Object.entries(services)) {
    if (service.build !== undefined)
      problems.push(`service ${name} builds its image`);
    if (!PINNED_IMAGE.test(service.image ?? ""))
      problems.push(
        `service ${name} runs ${service.image ?? "no image"}, not an image by digest`,
      );
    for (const port of service.ports ?? [])
      if (port.host_ip !== "127.0.0.1")
        problems.push(
          `service ${name} publishes ${port.published} on ${port.host_ip ?? "every interface"}`,
        );
  }
  for (const required of ["api", "scheduler", "egress-proxy", "postgres"])
    if (!(required in services))
      problems.push(`service ${required} is missing`);

  if (env("api", "AUTH_MODE") !== "api-key")
    problems.push("api AUTH_MODE must be api-key");
  if (env("api", "CHECKPOINT_OBJECT_PROTECTION") !== "locked")
    problems.push("api CHECKPOINT_OBJECT_PROTECTION must be locked");
  for (const name of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"])
    if (!URL_SAFE.test(env("postgres", name) ?? ""))
      problems.push(
        `${name} may hold only letters, digits and . _ ~ - (it goes into DATABASE_URL unescaped)`,
      );
  const installation = env("scheduler", "EXECUTION_INSTALLATION_ID") ?? "";
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(installation) || installation === "local")
    problems.push(
      `EXECUTION_INSTALLATION_ID must name this installation, not ${JSON.stringify(installation)} (local is the local stack's)`,
    );
  if (env("scheduler", "EXECUTION_WORKSPACE_QUOTA") !== "on")
    problems.push("EXECUTION_WORKSPACE_QUOTA must be on (xfs with prjquota)");

  const bucket = env("api", "S3_BUCKET") ?? "";
  const region = env("api", "AWS_REGION") ?? "";
  const endpoint = env("api", "AWS_ENDPOINT_URL");
  const list = (name: string) =>
    (env("egress-proxy", name) ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  if (options.store === "localstack") {
    if (!("localstack" in services))
      problems.push("service localstack is missing (store localstack)");
    if (endpoint !== LOCALSTACK_ENDPOINT)
      problems.push(`api AWS_ENDPOINT_URL must be ${LOCALSTACK_ENDPOINT}`);
    if (bucket !== LOCALSTACK_BUCKET)
      problems.push(
        `S3_BUCKET must be ${LOCALSTACK_BUCKET}, the bucket LocalStack creates`,
      );
    if (
      !list("EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST").includes("localstack:4566")
    )
      problems.push(
        "EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST must name localstack:4566, or workers cannot write checkpoints",
      );
  } else {
    if (endpoint !== undefined)
      problems.push("api AWS_ENDPOINT_URL must be unset: the store is AWS S3");
    // The object store route calls the virtual-hosted name, or the regional
    // one for a bucket name with a dot (docs/operations.md).
    const s3Host = bucket.includes(".")
      ? `s3.${region}.amazonaws.com:443`
      : `${bucket}.s3.${region}.amazonaws.com:443`;
    if (!list("EGRESS_CREDENTIAL_ALLOWLIST").includes(s3Host))
      problems.push(
        `EGRESS_CREDENTIAL_ALLOWLIST must name ${s3Host}, or workers cannot write checkpoints`,
      );
  }
  for (const entry of list("EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST"))
    if (localOnly.includes(entry.split(":")[0] ?? ""))
      problems.push(
        `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST names ${entry}, a local-only service`,
      );

  let revision = "";
  const catalog = services.api?.volumes?.find(
    (volume) => volume.target === "/app/config",
  )?.source;
  if (catalog === undefined)
    problems.push("api mounts no catalog at /app/config");
  else if (catalog === REPO_ROOT || catalog.startsWith(REPO_ROOT + sep))
    problems.push(`catalog ${catalog} is inside the checkout; keep it outside`);
  else if (!(await stat(catalog).catch(() => undefined))?.isDirectory())
    problems.push(`catalog ${catalog} is not a directory`);
  else {
    revision = await catalogRevision(catalog);
    if (
      options.catalogRevision !== undefined &&
      options.catalogRevision !== revision
    )
      problems.push(
        `catalog ${catalog} is ${revision}, the manifest says ${options.catalogRevision}`,
      );
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return revision;
}

/**
 * The API's own first write, hold and collection on a scratch key: create-
 * only put, legal hold, read back by version, then what checkpoint GC does —
 * lift the hold and delete the version. The API's startup check reads the
 * bucket's settings only, so this is what proves the credentials may write,
 * hold and collect. Each failure names the S3 permission of its step.
 */
export async function probeRoundTrip(input: {
  readonly collector: CheckpointObjectCollector;
  readonly key: string;
  readonly objects: CheckpointObjectStore;
}): Promise<void> {
  const { collector, key, objects } = input;
  const step = async <T>(action: string, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      throw new Error(
        `${action} on ${key} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const body = new TextEncoder().encode(`test-ops preflight ${key}\n`);
  const put = await step("s3:PutObject (If-None-Match)", () =>
    objects.putImmutable(key, body),
  );
  if (put.outcome !== "created" || put.version === undefined)
    throw new Error(
      `s3:PutObject on ${key} answered ${put.outcome} without a version; the bucket must be versioned`,
    );
  const { version } = put;
  await step("s3:PutObjectLegalHold", async () => {
    if (objects.hold === undefined)
      throw new Error("the store places no legal holds");
    await objects.hold(key, version);
  });
  const head = await step("s3:GetObjectLegalHold", () =>
    objects.head(key, version),
  );
  if (head?.held !== true)
    throw new Error(
      `${key} (version ${version}) reads back without its legal hold`,
    );
  const read = await step("s3:GetObjectVersion", () =>
    objects.get(key, version),
  );
  if (
    read === undefined ||
    Buffer.compare(Buffer.from(read), Buffer.from(body)) !== 0
  )
    throw new Error(`${key} (version ${version}) reads back different bytes`);
  await step("s3:PutObjectLegalHold (release) and s3:DeleteObjectVersion", () =>
    collector.purge({ deleteMarker: false, key, version }),
  );
  const left = await step("s3:ListBucketVersions", () =>
    collector.listVersions(key),
  );
  const remaining = left.filter((entry) => entry.key === key).length;
  if (remaining > 0)
    throw new Error(
      `${key} still has ${remaining} version(s) after the delete`,
    );
}

/** The API's startup bucket checks, then the round trip, with its settings. */
export async function probeStore(model: RenderedModel): Promise<string> {
  const environment = model.services?.api?.environment ?? {};
  const config = checkpointStorageConfigFromEnv(
    Object.fromEntries(
      Object.entries(environment).map(([name, value]) => [
        name,
        value ?? undefined,
      ]),
    ),
  );
  if (config === "disabled" || config.protection !== "locked")
    throw new Error("api must run the object store locked");
  await assertCheckpointBucketProtection(config);
  await assertCheckpointBucketEncryption(config, {
    warn: (message) => {
      throw new Error(message);
    },
  });
  const client = createStorageS3Client({
    s3: {
      accessKeyId: config.accessKeyId,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      region: config.region,
      secretAccessKey: config.secretAccessKey,
    },
  });
  try {
    await probeRoundTrip({
      collector: createCheckpointObjectCollector({
        bucket: config.bucket,
        client,
      }),
      key: `test-ops-preflight/${new Date().toISOString()}-${randomUUID()}`,
      objects: createCheckpointObjectStore({ bucket: config.bucket, client }),
    });
  } finally {
    client.destroy();
  }
  return config.bucket;
}

export type UpgradeVerdict =
  | { readonly proceed: true; readonly approved: readonly string[] }
  | { readonly proceed: false; readonly reason: string };

export type UpgradeImpact = {
  readonly affected: readonly string[];
  readonly failClosed: boolean;
  readonly reason?: string;
};

/**
 * Reads verify-restore's complete run, accepting exit 5 only when every
 * failure is a target-image incompatibility. Any incomplete or mixed result
 * falls back to all uncollected sessions.
 */
export function upgradeImpact(input: {
  readonly exitCode: number;
  readonly output: string;
  readonly uncollected: readonly string[];
}): UpgradeImpact {
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  const fallback = sorted(input.uncollected);
  const failClosed = (reason: string): UpgradeImpact => ({
    affected: fallback,
    failClosed: true,
    reason,
  });
  const lines = input.output.split("\n").map((line) => line.trim());
  const failures = lines.filter((line) => line.startsWith("FAIL "));
  const summaries = lines.flatMap((line) => {
    const match = /^checkpoints=\d+ passed=\d+ failed=(\d+)$/.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
  if (summaries.length !== 1)
    return failClosed("verify-restore did not produce one complete summary");
  if (summaries[0] !== failures.length)
    return failClosed("verify-restore's summary does not match its failures");
  if (
    (failures.length === 0 && input.exitCode !== 0) ||
    (failures.length > 0 && input.exitCode !== 5)
  )
    return failClosed(
      `verify-restore exited ${input.exitCode} for ${failures.length} failure(s)`,
    );

  const incompatible: string[] = [];
  for (const failure of failures) {
    const match =
      /^FAIL (.+)@[0-9]+ plan: incompatible with the target image \(checkpoint → image\): /.exec(
        failure,
      );
    if (match === null)
      return failClosed(
        "verify-restore found a failure other than incompatibility",
      );
    incompatible.push(match[1] as string);
  }
  const affected = sorted(incompatible);
  const uncollected = new Set(fallback);
  if (affected.some((sessionId) => !uncollected.has(sessionId)))
    return failClosed(
      "verify-restore named an incompatible session outside the uncollected set",
    );
  return { affected, failClosed: false };
}

/**
 * The upgrade goes ahead only when no session is incompatible with the target
 * worker image, or when the operator approved exactly the sessions that are:
 * one more or one fewer means the list they read is not the one that would
 * break.
 */
export function decideUpgrade(input: {
  readonly affected: readonly string[];
  readonly approved?: readonly string[];
  readonly fromWorker: string;
  readonly toWorker: string;
}): UpgradeVerdict {
  const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
  const affected = sorted(input.affected);
  if (input.fromWorker === input.toWorker || affected.length === 0)
    return { approved: [], proceed: true };
  const header = `the worker image changes (${input.fromWorker} -> ${input.toWorker}) and ${affected.length} session(s) have checkpoints it cannot restore:\n${affected.join("\n")}`;
  if (input.approved === undefined)
    return {
      proceed: false,
      reason: `${header}\napprove exactly this list to go ahead`,
    };
  const approved = sorted(input.approved);
  if (approved.join("\n") !== affected.join("\n")) {
    const missing = affected.filter((id) => !approved.includes(id));
    const extra = approved.filter((id) => !affected.includes(id));
    return {
      proceed: false,
      reason: `${header}\nthe approved list differs — not approved: ${missing.join(" ") || "none"}; no longer affected: ${extra.join(" ") || "none"}`,
    };
  }
  return { approved: affected, proceed: true };
}

const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

async function stdinModel(): Promise<RenderedModel> {
  return JSON.parse(await Bun.stdin.text()) as RenderedModel;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "manifest": {
      const [file] = args;
      if (!file || args.length > 1) return usage();
      const manifest = parseReleaseManifest(
        JSON.parse(await readFile(file, "utf8")),
      );
      console.log(
        [
          `SOURCE_COMMIT=${manifest.sourceCommit}`,
          `API_IMAGE=${manifest.images.controlHost}`,
          `WORKER_IMAGE=${manifest.images.worker}`,
          `EGRESS_PROXY_IMAGE=${manifest.images.egressProxy}`,
          `CATALOG_REVISION=${manifest.catalogRevision}`,
        ].join("\n"),
      );
      return 0;
    }
    case "catalog-revision": {
      const [dir] = args;
      if (!dir || args.length > 1) return usage();
      console.log(await catalogRevision(dir));
      return 0;
    }
    case "check-render": {
      const [storeFlag, store, revisionFlag, revision, ...rest] = args;
      if (
        storeFlag !== "--store" ||
        !OBJECT_STORE_MODES.includes(store as ObjectStoreMode) ||
        rest.length > 0 ||
        (revisionFlag !== undefined &&
          (revisionFlag !== "--catalog-revision" || revision === undefined))
      )
        return usage();
      console.log(
        await checkRender(await stdinModel(), {
          ...(revision === undefined ? {} : { catalogRevision: revision }),
          store: store as ObjectStoreMode,
        }),
      );
      return 0;
    }
    case "probe-store": {
      if (args.length !== 0) return usage();
      const bucket = await probeStore(await stdinModel());
      console.error(
        `probe-store: ${bucket} is versioned, Object Lock and SSE-S3; put, hold, read, release and delete passed`,
      );
      return 0;
    }
    case "upgrade-impact": {
      const [exitCodeText, output, uncollected] = args;
      if (!exitCodeText || !output || !uncollected || args.length !== 3)
        return usage();
      const exitCode = Number(exitCodeText);
      if (!Number.isSafeInteger(exitCode) || exitCode < 0) return usage();
      const impact = upgradeImpact({
        exitCode,
        output: await readFile(output, "utf8"),
        uncollected: await lines(uncollected),
      });
      if (impact.failClosed)
        console.error(
          `upgrade impact: ${impact.reason}; fail-closed to all ${impact.affected.length} uncollected session(s)`,
        );
      console.log(impact.affected.join("\n"));
      return 0;
    }
    case "upgrade-gate": {
      const [fromWorker, toWorker, affected, approved] = args;
      if (!fromWorker || !toWorker || !affected || args.length > 4)
        return usage();
      const verdict = decideUpgrade({
        affected: await lines(affected),
        ...(approved === undefined ? {} : { approved: await lines(approved) }),
        fromWorker,
        toWorker,
      });
      if (!verdict.proceed) {
        console.error(`upgrade refused: ${verdict.reason}`);
        return EXIT_REFUSED;
      }
      console.log(verdict.approved.join("\n"));
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error(
    "usage: test-ops.ts manifest <file> | catalog-revision <dir> | check-render --store <localstack|s3> [--catalog-revision <rev>] | probe-store | upgrade-impact <verify-exit> <verify-output> <uncollected> | upgrade-gate <from-worker> <to-worker> <affected> [<approved>]",
  );
  return 2;
}

if (import.meta.main) {
  let code: number;
  try {
    code = await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${process.argv[2]}: ${error instanceof Error ? error.message : String(error)}`,
    );
    code = 1;
  }
  process.exit(code);
}

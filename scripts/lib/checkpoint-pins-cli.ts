/**
 * The checkpoint-object steps of scripts/backup.sh, restore.sh and
 * verify-restore.sh (94S-282), run on the host against an installation's
 * published ports. See scripts/lib/checkpoint-pins.ts for what each checks.
 *
 *   bun run scripts/lib/checkpoint-pins-cli.ts capture <backup>/objects
 *   bun run scripts/lib/checkpoint-pins-cli.ts repin <backup>/objects
 *   bun run scripts/lib/checkpoint-pins-cli.ts plans [--image <worker image> <config dir>]
 *
 * Environment: DATABASE_URL, S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL unless the store is AWS S3
 * itself. Problems go to stderr; exit 1
 * when capture or repin refuses, 5 when a plan check fails.
 */

import * as schema from "@agent-platform/db";
import { createPostgresCheckpointStore } from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { createLogger } from "@agent-platform/observability";
import { resolveSessionCatalog } from "@agent-platform/platform";
import { claudeCheckpointCodec } from "@agent-platform/runtime-claude";
import type { RuntimeFingerprint } from "@agent-platform/runtime-core";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  describeBucketProtection,
} from "@agent-platform/storage";
import { drizzle } from "drizzle-orm/node-postgres";
import { readCatalogConfig } from "../../apps/control-host/src/api/catalog-config.ts";
import {
  API_CHECKPOINT_CODECS,
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  createApiCheckpointService,
} from "../../apps/control-host/src/api/checkpoints.ts";
import {
  applyRepin,
  CheckpointPinError,
  type CheckpointRow,
  captureCheckpointObjects,
  describeMismatches,
  type ImageRuntime,
  parseImageRuntime,
  planRepin,
  planRuntime,
  sessionClaim,
  sha256Hex,
} from "./checkpoint-pins.ts";
import { s3SettingsFromEnv } from "./object-store-cli.ts";

const EXIT_VERIFY_FAILED = 5;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const [command, objectsDir, imageName, configDir, ...extra] =
  process.argv.slice(2);
if (
  extra.length > 0 ||
  !(
    (command === "capture" && objectsDir && imageName === undefined) ||
    (command === "repin" && objectsDir && imageName === undefined) ||
    (command === "plans" && objectsDir === undefined) ||
    (command === "plans" && objectsDir === "--image" && imageName && configDir)
  )
) {
  console.error(
    "usage: checkpoint-pins-cli.ts capture <objects-dir> | repin <objects-dir> | plans [--image <worker image> <config dir>]",
  );
  process.exit(2);
}
const image =
  imageName === undefined
    ? undefined
    : { name: imageName, configDir: configDir as string };

const s3 = s3SettingsFromEnv();
const bucket = env("S3_BUCKET");
const client = createStorageS3Client({ s3 });
const objects = createCheckpointObjectStore({ bucket, client });
const pool = createEnforcedPool(
  env("DATABASE_URL"),
  createLogger(),
  "checkpoint-pins",
  JOB_POOL_TIMEOUTS,
);
const codecs = API_CHECKPOINT_CODECS;

// A row garbage collection marked is no longer restorable and its objects
// are gone or going (94S-281): neither backed up nor re-pinned.
async function readRows(): Promise<CheckpointRow[]> {
  const { rows } = await pool.query<{
    manifest_ref: string;
    manifest_sha256: string;
    manifest_version: string | null;
    revision: number;
    session_id: string;
  }>(
    `SELECT session_id, revision, manifest_ref, manifest_sha256, manifest_version
     FROM checkpoints WHERE collected_at IS NULL ORDER BY session_id, revision`,
  );
  return rows.map((row) => ({
    manifestRef: row.manifest_ref,
    manifestSha256: row.manifest_sha256,
    manifestVersion: row.manifest_version,
    revision: Number(row.revision),
    sessionId: row.session_id,
  }));
}

async function capture(dir: string) {
  const rows = await readRows();
  const { replaced } = await captureCheckpointObjects({
    codecs,
    objects,
    objectsDir: dir,
    rows,
  });
  for (const key of replaced) {
    console.error(
      `capture: warning — ${key} now holds the bytes its checkpoint pinned; the bucket's current object differs or is gone`,
    );
  }
  console.log(
    JSON.stringify({ checkpoints: rows.length, replaced: replaced.length }),
  );
}

async function repin(dir: string) {
  // The restored API refuses to start `locked` on anything less, and holds
  // need Object Lock; better to stop before writing a single manifest.
  const protection = await describeBucketProtection(client, bucket);
  if (protection.versioning !== "Enabled" || !protection.objectLock) {
    throw new Error(
      `restored bucket ${bucket} has versioning ${protection.versioning} and Object Lock ${protection.objectLock ? "enabled" : "not configured"}; re-pinning needs both`,
    );
  }
  await assertCheckpointBucketEncryption(
    { ...s3, bucket, protection: "locked" },
    { client, warn: () => {} },
  );
  const rows = await readRows();
  const planned = await planRepin({ codecs, objects, objectsDir: dir, rows });
  const repinned = await applyRepin({ objects, planned });
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const row of repinned) {
      const updated = await db.query(
        `UPDATE checkpoints
         SET manifest_sha256 = $3, manifest_version = $4, versions_held = true
         WHERE session_id = $1 AND revision = $2 AND manifest_sha256 = $5`,
        [
          row.sessionId,
          row.revision,
          row.manifestSha256,
          row.manifestVersion,
          row.previousSha256,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `checkpoint ${row.sessionId}@${row.revision} changed while it was re-pinned`,
        );
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  console.log(JSON.stringify({ checkpoints: repinned.length }));
}

/**
 * What the restored API itself would answer: the startup bucket check, then
 * `getRestorePlan` through the production wiring in `locked` mode for every
 * session pointer, and every object of every ready plan read back by the
 * version the plan names and found held. With an image, each plan is asked
 * for as a worker of that image would ask: its engine build, and the profile
 * digest its code computes from the claim the catalog in `configDir` gives.
 */
async function plans(
  image: { name: string; configDir: string } | undefined,
): Promise<number> {
  const config = {
    ...s3,
    bucket,
    protection: "locked" as const,
  };
  let failed = 0;
  const fail = (message: string) => {
    failed += 1;
    console.log(`FAIL ${message}`);
  };
  try {
    const found = await describeBucketProtection(client, bucket);
    await assertCheckpointBucketProtection(config);
    await assertCheckpointBucketEncryption(config, { client, warn: () => {} });
    console.log(
      `PASS bucket ${bucket}: ${JSON.stringify(found)}, passes the locked startup check`,
    );
  } catch (error) {
    fail(`bucket ${bucket}: ${(error as Error).message}`);
    return failed;
  }
  // createApiCheckpoints' own wiring, with the service itself in hand.
  const service = createApiCheckpointService({
    codecs: API_CHECKPOINT_CODECS,
    objectProtection: config.protection,
    objects,
    store: createPostgresCheckpointStore(drizzle(pool, { schema })),
  });
  const { rows: pointers } = await pool.query<{
    branch: string;
    id: string;
    manifest_ref: string | null;
    manifest_version: string | null;
    owner_id: string;
    profile_fingerprint: string | null;
    profile_id: string | null;
    repo_url: string;
    repository_id: string | null;
    revision: number;
  }>(
    `SELECT s.id, s.checkpoint_revision AS revision, c.manifest_ref, c.manifest_version,
            s.owner_id, s.profile_id, s.profile_fingerprint, s.repository_id, s.repo_url, s.branch
     FROM sessions s LEFT JOIN checkpoints c
       ON c.session_id = s.id AND c.revision = s.checkpoint_revision
     WHERE s.checkpoint_revision IS NOT NULL ORDER BY s.id`,
  );
  const claimErrors = new Map<string, string>();
  let imageRuntime: ImageRuntime | undefined;
  if (image !== undefined) {
    // Credentials are resolved to a stand-in: the claim carries a token in
    // their place and the digest reads neither.
    const catalog = resolveSessionCatalog(
      await readCatalogConfig(image.configDir),
      () => "verify-restore-reads-no-credential",
    );
    const claims: Record<string, unknown> = {};
    for (const pointer of pointers) {
      try {
        claims[pointer.id] = sessionClaim(
          {
            branch: pointer.branch,
            ownerId: pointer.owner_id,
            profileFingerprint: pointer.profile_fingerprint,
            profileId: pointer.profile_id,
            repoUrl: pointer.repo_url,
            repositoryId: pointer.repository_id,
          },
          catalog,
        );
      } catch (error) {
        claimErrors.set(pointer.id, (error as Error).message);
      }
    }
    imageRuntime = await readImageRuntime(image.name, claims);
  }
  for (const pointer of pointers) {
    const tag = `${pointer.id}@${pointer.revision} plan`;
    if (pointer.manifest_ref === null || pointer.manifest_version === null) {
      fail(`${tag}: pointer has no versioned checkpoints row`);
      continue;
    }
    // The plan is judged on storage, not on this host's engine build: the
    // runtime asked for is the target image's, or with none the one the
    // manifest was sealed under. A pointer whose version is gone still gets
    // the service's own verdict, so the runtime then comes from whatever the
    // key holds.
    const manifestBytes = await objects.get(
      pointer.manifest_ref,
      pointer.manifest_version,
    );
    const runtimeSource =
      manifestBytes ?? (await objects.get(pointer.manifest_ref));
    if (runtimeSource === undefined) {
      fail(`${tag}: no manifest at ${pointer.manifest_ref} at all`);
      continue;
    }
    const claimError = claimErrors.get(pointer.id);
    if (claimError !== undefined) {
      fail(`${tag}: no claim for the target image: ${claimError}`);
      continue;
    }
    let runtime: RuntimeFingerprint;
    try {
      runtime = planRuntime(
        claudeCheckpointCodec.decode(runtimeSource).runtime,
        imageRuntime,
        pointer.id,
      );
    } catch (error) {
      fail(`${tag}: ${(error as Error).message}`);
      continue;
    }
    const result = await service.getRestorePlan({
      runtime,
      sessionId: pointer.id,
    });
    if (result.status === "incompatible") {
      fail(
        `${tag}: incompatible with the target image (checkpoint → image): ${describeMismatches(result.mismatches)}`,
      );
      continue;
    }
    if (result.status !== "ready" || manifestBytes === undefined) {
      fail(`${tag}: ${JSON.stringify(result)}`);
      continue;
    }
    const { plan } = result;
    let ok = true;
    if (plan.manifestVersion !== pointer.manifest_version) {
      fail(
        `${tag}: plan names manifest version ${plan.manifestVersion}, the pointer ${pointer.manifest_version}`,
      );
      ok = false;
    }
    const pinned = [
      {
        bytes: manifestBytes.byteLength,
        key: plan.manifestRef,
        sha256: sha256Hex(manifestBytes),
        version: plan.manifestVersion,
      },
      ...plan.artifacts.flatMap((artifact) => artifact.objects),
    ];
    for (const object of pinned) {
      if (object.version === undefined) {
        fail(`${tag}: ${object.key} has no version in the plan`);
        ok = false;
        continue;
      }
      const bytes = await objects.get(object.key, object.version);
      if (
        bytes === undefined ||
        bytes.byteLength !== object.bytes ||
        sha256Hex(bytes) !== object.sha256
      ) {
        fail(
          `${tag}: ${object.key} version ${object.version} does not read back`,
        );
        ok = false;
        continue;
      }
      const head = await objects.head(object.key, object.version);
      if (head?.held !== true) {
        fail(`${tag}: ${object.key} version ${object.version} is not held`);
        ok = false;
      }
    }
    if (ok) {
      console.log(
        `PASS ${tag}: ready under locked${image === undefined ? "" : ` for image ${image.name}`}, ${pinned.length} versions read back and held`,
      );
    }
  }
  if (pointers.length === 0) {
    console.error("plans: warning — no session has a checkpoint pointer");
  }
  return failed;
}

/**
 * Runs the image's own bun with no network on the claims
 * (apps/worker/src/image-runtime.ts). The image has no label for any of it.
 */
async function readImageRuntime(
  name: string,
  claims: Record<string, unknown>,
): Promise<ImageRuntime> {
  const child = Bun.spawn(
    [
      "docker",
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--entrypoint",
      "bun",
      name,
      "run",
      "apps/worker/src/image-runtime.ts",
    ],
    {
      stdin: new Blob([JSON.stringify(claims)]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `could not read the runtime of image ${name} (exit ${code}): ${stderr.trim()}`,
    );
  }
  return parseImageRuntime(stdout.trim());
}

let exitCode = 0;
try {
  if (command === "capture") await capture(objectsDir as string);
  else if (command === "repin") await repin(objectsDir as string);
  else if ((await plans(image)) > 0) exitCode = EXIT_VERIFY_FAILED;
} catch (error) {
  if (error instanceof CheckpointPinError) {
    console.error(`${command}: ${error.message}`);
  } else {
    console.error(`${command}: ${(error as Error).stack ?? String(error)}`);
  }
  exitCode = 1;
} finally {
  await pool.end();
  client.destroy();
}
process.exit(exitCode);

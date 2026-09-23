/**
 * The checkpoint-object steps of scripts/backup.sh, restore.sh and
 * verify-restore.sh (94S-282), run on the host against an installation's
 * published ports. See scripts/lib/checkpoint-pins.ts for what each checks.
 *
 *   bun run scripts/lib/checkpoint-pins-cli.ts capture <backup>/objects
 *   bun run scripts/lib/checkpoint-pins-cli.ts repin <backup>/objects
 *   bun run scripts/lib/checkpoint-pins-cli.ts plans
 *
 * Environment: DATABASE_URL, S3_BUCKET, AWS_ENDPOINT_URL, AWS_REGION,
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY. Problems go to stderr; exit 1
 * when capture or repin refuses, 5 when a plan check fails.
 */

import * as schema from "@agent-platform/db";
import { createPostgresCheckpointStore } from "@agent-platform/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@agent-platform/db/pool";
import { createLogger } from "@agent-platform/observability";
import { claudeCheckpointCodec } from "@agent-platform/runtime-claude";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  describeBucketProtection,
} from "@agent-platform/storage";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  API_CHECKPOINT_CODECS,
  assertCheckpointBucketProtection,
  createApiCheckpointService,
} from "../../apps/api/src/checkpoints.ts";
import {
  applyRepin,
  CheckpointPinError,
  type CheckpointRow,
  captureCheckpointObjects,
  planRepin,
  sha256Hex,
} from "./checkpoint-pins.ts";

const EXIT_VERIFY_FAILED = 5;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const [command, objectsDir] = process.argv.slice(2);
if (
  !(
    (command === "capture" && objectsDir) ||
    (command === "repin" && objectsDir) ||
    command === "plans"
  )
) {
  console.error(
    "usage: checkpoint-pins-cli.ts capture <objects-dir> | repin <objects-dir> | plans",
  );
  process.exit(2);
}

const s3 = {
  accessKeyId: env("AWS_ACCESS_KEY_ID"),
  endpoint: env("AWS_ENDPOINT_URL"),
  region: env("AWS_REGION"),
  secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
};
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
 * version the plan names and found held.
 */
async function plans(): Promise<number> {
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
    id: string;
    manifest_ref: string | null;
    manifest_version: string | null;
    revision: number;
  }>(
    `SELECT s.id, s.checkpoint_revision AS revision, c.manifest_ref, c.manifest_version
     FROM sessions s LEFT JOIN checkpoints c
       ON c.session_id = s.id AND c.revision = s.checkpoint_revision
     WHERE s.checkpoint_revision IS NOT NULL ORDER BY s.id`,
  );
  for (const pointer of pointers) {
    const tag = `${pointer.id}@${pointer.revision} plan`;
    if (pointer.manifest_ref === null || pointer.manifest_version === null) {
      fail(`${tag}: pointer has no versioned checkpoints row`);
      continue;
    }
    // The plan is judged on storage, not on this host's engine build: the
    // runtime asked for is the one the manifest was sealed under. A pointer
    // whose version is gone still gets the service's own verdict, so the
    // runtime then comes from whatever the key holds.
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
    const result = await service.getRestorePlan({
      runtime: claudeCheckpointCodec.decode(runtimeSource).runtime,
      sessionId: pointer.id,
    });
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
        `PASS ${tag}: ready under locked, ${pinned.length} versions read back and held`,
      );
    }
  }
  if (pointers.length === 0) {
    console.error("plans: warning — no session has a checkpoint pointer");
  }
  return failed;
}

let exitCode = 0;
try {
  if (command === "capture") await capture(objectsDir as string);
  else if (command === "repin") await repin(objectsDir as string);
  else if ((await plans()) > 0) exitCode = EXIT_VERIFY_FAILED;
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

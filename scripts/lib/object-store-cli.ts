/**
 * The object store steps of scripts/backup.sh, restore.sh and
 * verify-restore.sh (94S-429), through the production S3 adapter, so the
 * scripts run the same against the compose project's LocalStack and against
 * any S3-compatible store, AWS S3 included:
 *
 *   bun run scripts/lib/object-store-cli.ts download <dir>
 *   bun run scripts/lib/object-store-cli.ts check-target [--create] [--source-bucket <b>] [--source-endpoint <url>]
 *   bun run scripts/lib/object-store-cli.ts upload <dir> [<skip-keys-file>]
 *   bun run scripts/lib/object-store-cli.ts count
 *   bun run scripts/lib/object-store-cli.ts read <key> <version> <out-file>
 *   bun run scripts/lib/object-store-cli.ts create-only-check
 *
 * Environment: S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL unless the store is AWS S3
 * itself — the variables the API reads (`storageConfigFromEnv`).
 *
 * Exit 2 on usage, 4 when check-target refuses the bucket as a restore
 * target (the source's own, or not empty), 1 on anything else.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  describeBucketEncryption,
  describeBucketProtection,
  type S3ClientLike,
} from "@agent-platform/storage";
import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { backupPath } from "./checkpoint-pins.ts";

export const EXIT_TARGET_REFUSED = 4;

export class TargetRefusedError extends Error {}

export type S3Settings = {
  readonly accessKeyId: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly secretAccessKey: string;
};

export function s3SettingsFromEnv(): S3Settings {
  const endpoint = process.env.AWS_ENDPOINT_URL?.trim();
  return {
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    ...(endpoint ? { endpoint } : {}),
    region: required("AWS_REGION"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * One spelling per endpoint, so the same store named two ways still counts
 * as the same: no endpoint is AWS S3 itself, and `localhost` is the loopback
 * the scripts publish on.
 */
export function endpointIdentity(endpoint: string | undefined): string {
  if (!endpoint) return "aws";
  try {
    const url = new URL(endpoint);
    const host = url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
    return `${url.protocol}//${host}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return endpoint.trim().toLowerCase();
  }
}

/**
 * Refuses a restore target that is not a fresh, locked bucket: the source
 * installation's own bucket, a bucket missing versioning, Object Lock or
 * SSE-S3, or one that holds a single object version or delete marker. Reads
 * only; `create` makes a missing bucket first (the restore's own LocalStack).
 * `source.endpoint` undefined means the backup did not record one, and then
 * the bucket name alone decides.
 */
export async function checkRestoreTarget(input: {
  readonly bucket: string;
  readonly client: S3ClientLike;
  readonly create?: { readonly region: string };
  readonly endpoint: string | undefined;
  readonly source?: { readonly bucket: string; readonly endpoint?: string };
}): Promise<void> {
  const { bucket, client, source } = input;
  if (
    source !== undefined &&
    source.bucket === bucket &&
    (source.endpoint === undefined ||
      endpointIdentity(source.endpoint) === endpointIdentity(input.endpoint))
  ) {
    throw new TargetRefusedError(
      `bucket ${bucket} at ${endpointIdentity(input.endpoint)} is the source installation's bucket; restore only into a new, empty bucket`,
    );
  }
  if (input.create !== undefined && !(await bucketExists(client, bucket))) {
    const { region } = input.create;
    await client.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 is the one region S3 refuses to be named in.
        ...(region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: region as BucketLocationConstraint,
              },
            }),
        ObjectLockEnabledForBucket: true,
      }),
    );
    await client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucket,
        ServerSideEncryptionConfiguration: {
          Rules: [
            { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
          ],
        },
      }),
    );
  }
  // What the restored API refuses to start `locked` on, and what re-pinning
  // needs: versions to pin, holds to place, SSE-S3 for every object written.
  const protection = await describeBucketProtection(client, bucket);
  if (protection.versioning !== "Enabled" || !protection.objectLock) {
    throw new Error(
      `bucket ${bucket} has versioning ${protection.versioning} and Object Lock ${protection.objectLock ? "enabled" : "not configured"}; a restore needs both`,
    );
  }
  const encryption = await describeBucketEncryption(client, bucket);
  if (encryption !== "AES256") {
    throw new Error(
      `bucket ${bucket} encrypts new objects with ${encryption}; a restore needs the bucket default SSE-S3 (AES256)`,
    );
  }
  // Delete markers and noncurrent versions count: an object once written
  // here may be what some other installation's checkpoint pins.
  const page = (await client.send(
    new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1 }),
  )) as { DeleteMarkers?: unknown[]; Versions?: unknown[] };
  if ((page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0) > 0) {
    throw new TargetRefusedError(
      `bucket ${bucket} is not empty (it has object versions or delete markers); restore only into a new, empty bucket`,
    );
  }
}

async function bucketExists(client: S3ClientLike, bucket: string) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw error;
  }
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
    else throw new Error(`${path} is neither a file nor a directory`);
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Each chunk copied: the stream may refill a buffer it already handed out. */
function writeChunks(chunks: AsyncIterable<Uint8Array>, path: string) {
  return pipeline(
    (async function* () {
      for await (const chunk of chunks) yield Buffer.from(chunk);
    })(),
    createWriteStream(path, { mode: 0o600 }),
  );
}

function isPreconditionFailed(error: unknown): boolean {
  const found = error as {
    $metadata?: { httpStatusCode?: number };
    name?: string;
  };
  return (
    found?.name === "PreconditionFailed" ||
    found?.$metadata?.httpStatusCode === 412
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const bucket = required("S3_BUCKET");
  const s3 = s3SettingsFromEnv();
  const client = createStorageS3Client({ s3 });
  const objects = createCheckpointObjectStore({ bucket, client });
  try {
    switch (command) {
      // Every current object, key = path under <dir>. The pinned versions
      // are checkpoint-pins-cli.ts capture's job afterwards.
      case "download": {
        const [dir] = args;
        if (!dir) return usage();
        const keys = await objects.list("");
        for (const key of keys) {
          const path = backupPath(dir, key);
          const chunks = await objects.stream(key);
          // Gone since the listing, as a sync would find it; a key some
          // checkpoint pins is fetched by version afterwards anyway.
          if (chunks === undefined) {
            console.error(`download: warning — ${key} was listed but is gone`);
            continue;
          }
          await mkdir(dirname(path), { recursive: true });
          const staged = `${path}.download-${process.pid}`;
          await writeChunks(chunks, staged);
          await rename(staged, path);
        }
        console.log(keys.length);
        return 0;
      }
      case "check-target": {
        let create = false;
        let sourceBucket: string | undefined;
        let sourceEndpoint: string | undefined;
        for (let i = 0; i < args.length; i += 1) {
          const arg = args[i];
          if (arg === "--create") create = true;
          else if (arg === "--source-bucket") sourceBucket = args[++i];
          else if (arg === "--source-endpoint") sourceEndpoint = args[++i];
          else return usage();
        }
        await checkRestoreTarget({
          bucket,
          client,
          ...(create ? { create: { region: s3.region } } : {}),
          endpoint: s3.endpoint,
          ...(sourceBucket === undefined
            ? {}
            : {
                source: {
                  bucket: sourceBucket,
                  ...(sourceEndpoint ? { endpoint: sourceEndpoint } : {}),
                },
              }),
        });
        console.error(
          `check-target: bucket ${bucket} is versioned, Object Lock, SSE-S3 and empty`,
        );
        return 0;
      }
      // Create-only: the target was checked empty, so any key already there
      // was written by someone else meanwhile, and the restore stops.
      case "upload": {
        const [dir, skipFile] = args;
        if (!dir) return usage();
        const skip = new Set(
          skipFile === undefined
            ? []
            : (await readFile(skipFile, "utf8")).split("\n").filter(Boolean),
        );
        let uploaded = 0;
        for await (const path of files(dir)) {
          const key = relative(dir, path);
          if (backupPath(dir, key) !== path) {
            throw new Error(`${path} maps to no object key`);
          }
          if (skip.has(key)) continue;
          const source = {
            bytes: (await stat(path)).size,
            open: () => createReadStream(path),
            sha256: await sha256OfFile(path),
          };
          const result = await objects.putImmutable(key, source);
          if (result.outcome !== "created") {
            throw new Error(
              `${key}: the target already holds an object there (${result.outcome}); it was not empty when the upload ran`,
            );
          }
          uploaded += 1;
        }
        console.log(uploaded);
        return 0;
      }
      case "count": {
        console.log((await objects.list("")).length);
        return 0;
      }
      // Bytes to <out-file>, the legal hold (ON or OFF) on stdout; exit 1
      // when that version is not there.
      case "read": {
        const [key, version, out] = args;
        if (!key || !version || !out) return usage();
        const chunks = await objects.stream(key, version);
        if (chunks === undefined) {
          console.error(`read: ${key} has no version ${version}`);
          return 1;
        }
        await writeChunks(chunks, out);
        const head = await objects.head(key, version);
        console.log(head?.held === true ? "ON" : "OFF");
        return 0;
      }
      // The store must still refuse to replace an object: a scratch key is
      // written once, then again with If-None-Match, which has to fail with
      // 412. Any other failure leaves the object untouched for the wrong
      // reason. The scratch version is deleted by id, leaving no marker.
      case "create-only-check": {
        const key = `verify-restore/${Date.now()}-${process.pid}`;
        const first = await client.send(
          new PutObjectCommand({
            Body: "one",
            Bucket: bucket,
            IfNoneMatch: "*",
            Key: key,
          }),
        );
        const versions = [(first as { VersionId?: string }).VersionId];
        try {
          try {
            const second = await client.send(
              new PutObjectCommand({
                Body: "two",
                Bucket: bucket,
                IfNoneMatch: "*",
                Key: key,
              }),
            );
            versions.push((second as { VersionId?: string }).VersionId);
            console.error(
              `create-only-check: a second write to ${key} was accepted`,
            );
            return 1;
          } catch (error) {
            if (!isPreconditionFailed(error)) throw error;
          }
          const stored = await objects.get(key);
          if (
            stored === undefined ||
            new TextDecoder().decode(stored) !== "one"
          ) {
            console.error(
              `create-only-check: ${key} no longer holds the first write`,
            );
            return 1;
          }
          return 0;
        } finally {
          for (const version of versions) {
            await client
              .send(
                new DeleteObjectCommand({
                  Bucket: bucket,
                  Key: key,
                  VersionId: version,
                }),
              )
              .catch((error: Error) =>
                console.error(
                  `create-only-check: warning — ${key} left behind: ${error.message}`,
                ),
              );
          }
        }
      }
      default:
        return usage();
    }
  } finally {
    client.destroy();
  }
}

function usage(): number {
  console.error(
    "usage: object-store-cli.ts download <dir> | check-target [--create] [--source-bucket <b>] [--source-endpoint <url>] | upload <dir> [<skip-keys-file>] | count | read <key> <version> <out> | create-only-check",
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
    code = error instanceof TargetRefusedError ? EXIT_TARGET_REFUSED : 1;
  }
  process.exit(code);
}

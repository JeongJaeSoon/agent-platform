import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LocalstackBucket,
  localstackEnabled,
  withLocalstackBucket,
} from "@agent-platform/testkit/localstack";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * The write paths of scripts/lib/object-store-cli.ts (94S-435) against
 * LocalStack: a create-only upload, the create-only probe that must leave
 * nothing behind, and a download that refuses keys no backup directory can
 * hold one file each for. The restore target refusals are
 * backup-restore.test.ts's, against a stand-in S3.
 */

const repoRoot = join(import.meta.dir, "..");
const cli = join(repoRoot, "scripts/lib/object-store-cli.ts");

async function run(bucket: LocalstackBucket, args: string[]) {
  const handle = Bun.spawn(["bun", "run", cli, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: bucket.env.accessKeyId,
      AWS_ENDPOINT_URL: bucket.env.endpoint,
      AWS_REGION: bucket.env.region,
      AWS_SECRET_ACCESS_KEY: bucket.env.secretAccessKey,
      S3_BUCKET: bucket.bucket,
    },
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

async function versionsUnder(bucket: LocalstackBucket, prefix: string) {
  const page = await bucket.s3.send(
    new ListObjectVersionsCommand({ Bucket: bucket.bucket, Prefix: prefix }),
  );
  return {
    markers: page.DeleteMarkers?.length ?? 0,
    versions: page.Versions?.length ?? 0,
  };
}

/**
 * A key with a `..` segment, which the SDK cannot send: Bun's HTTP client
 * resolves dot segments in the path, encoded ones too, before the request
 * leaves. curl sends the path as given.
 */
async function putDotSegmentKey(bucket: LocalstackBucket, key: string) {
  const { accessKeyId, endpoint, region, secretAccessKey } = bucket.env;
  const handle = Bun.spawn(
    [
      "curl",
      "--silent",
      "--show-error",
      "--fail",
      "--path-as-is",
      "--aws-sigv4",
      `aws:amz:${region}:s3`,
      "--user",
      `${accessKeyId}:${secretAccessKey}`,
      "--header",
      "x-amz-content-sha256: UNSIGNED-PAYLOAD",
      "--request",
      "PUT",
      "--data-binary",
      "outside",
      `${endpoint}/${bucket.bucket}/${key}`,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`curl PUT ${key}: ${stderr}`);
}

// Off rather than skipped where LocalStack is not configured: an
// undeclared skip fails the integration job (94S-307).
(localstackEnabled() ? describe : describe.skip)(
  "object-store-cli on LocalStack",
  () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "object-store-cli-"));
    });

    afterEach(async () => {
      await rm(dir, { force: true, recursive: true });
    });

    // A bucket, a CLI process of its own and several S3 calls per test:
    // Bun's 5s default is too tight for a slow LocalStack.
    const timeout = 30_000;
    // The upload and the probe run on a restore target, which is locked.
    const locked = { objectLock: true, prefix: "object-store-cli" };
    // Without Object Lock, so emptying the bucket afterwards sends no
    // per-key legal hold request, which the `..` key could not take.
    const plain = { prefix: "object-store-cli" };

    test(
      "upload stops at a key the bucket already holds and leaves its object as it was",
      async () => {
        await withLocalstackBucket(async (bucket) => {
          await bucket.s3.send(
            new PutObjectCommand({
              Body: "theirs",
              Bucket: bucket.bucket,
              Key: "sessions/s1/object",
            }),
          );
          await mkdir(join(dir, "sessions/s1"), { recursive: true });
          await writeFile(join(dir, "sessions/s1/object"), "ours");

          const result = await run(bucket, ["upload", dir]);

          expect(result).toMatchObject({ exitCode: 1 });
          expect(result.stderr).toContain(
            "sessions/s1/object: the target already holds an object there",
          );
          const stored = await bucket.s3.send(
            new GetObjectCommand({
              Bucket: bucket.bucket,
              Key: "sessions/s1/object",
            }),
          );
          expect(await stored.Body?.transformToString()).toBe("theirs");
          expect(await versionsUnder(bucket, "sessions/s1/object")).toEqual({
            markers: 0,
            versions: 1,
          });
        }, locked);
      },
      timeout,
    );

    test(
      "create-only-check passes and leaves no version or delete marker of its scratch key",
      async () => {
        await withLocalstackBucket(async (bucket) => {
          const result = await run(bucket, ["create-only-check"]);

          expect(result).toMatchObject({ exitCode: 0 });
          expect(await versionsUnder(bucket, "create-only-check/")).toEqual({
            markers: 0,
            versions: 0,
          });
        }, locked);
      },
      timeout,
    );

    test(
      "download refuses two keys that would be one file, writing nothing",
      async () => {
        await withLocalstackBucket(async (bucket) => {
          for (const Key of ["sessions/A", "sessions/a"]) {
            await bucket.s3.send(
              new PutObjectCommand({ Body: Key, Bucket: bucket.bucket, Key }),
            );
          }

          const result = await run(bucket, ["download", join(dir, "objects")]);

          expect(result).toMatchObject({ exitCode: 1 });
          expect(result.stderr).toContain(
            'keys "sessions/A" and "sessions/a" may share one file',
          );
          expect(await readdir(dir)).toEqual([]);
        }, plain);
      },
      timeout,
    );

    test(
      "download refuses a key that leaves the backup directory, writing nothing outside it",
      async () => {
        await withLocalstackBucket(async (bucket) => {
          await putDotSegmentKey(bucket, "../x");
          // The store holds the key as sent, not a resolved `x`.
          const listed = await bucket.s3.send(
            new ListObjectVersionsCommand({ Bucket: bucket.bucket }),
          );
          expect(listed.Versions?.map((version) => version.Key)).toEqual([
            "../x",
          ]);

          const result = await run(bucket, ["download", join(dir, "objects")]);

          expect(result).toMatchObject({ exitCode: 1 });
          expect(result.stderr).toContain(
            'object key "../x" has no single path in a backup',
          );
          expect(await readdir(dir)).toEqual([]);
        }, plain);
      },
      timeout,
    );
  },
);

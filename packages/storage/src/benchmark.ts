import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const endpoint = requireEnv("AWS_ENDPOINT_URL");
const region = requireEnv("AWS_REGION");
const accessKeyId = requireEnv("AWS_ACCESS_KEY_ID");
const secretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY");
const bucket = `storage-benchmark-${randomUUID()}`;
const client = new S3Client({
  credentials: { accessKeyId, secretAccessKey },
  endpoint,
  forcePathStyle: true,
  region,
});

await client.send(
  new CreateBucketCommand({
    Bucket: bucket,
    CreateBucketConfiguration: {
      LocationConstraint: region as "ap-northeast-1",
    },
  }),
);

try {
  for (const sizeMiB of [1, 5, 10, 25]) {
    const body = new Uint8Array(sizeMiB * 1024 * 1024).fill(0x61);
    const key = `${sizeMiB}-mib.jsonl`;
    const startedAt = performance.now();
    await client.send(
      new PutObjectCommand({ Body: body, Bucket: bucket, Key: key }),
    );
    const elapsedMilliseconds = performance.now() - startedAt;
    process.stdout.write(
      `${JSON.stringify({ elapsedMilliseconds, sizeMiB })}\n`,
    );
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
} finally {
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
  client.destroy();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Missing required benchmark environment variable: ${name}`);
  return value;
}

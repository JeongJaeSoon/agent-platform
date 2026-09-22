import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { S3CallTracker } from "./s3-diagnostics.ts";

export const localstackEnabled =
  process.env.SESSION_STORE_LOCALSTACK_TEST === "1";

/** Every S3 call this process makes through {@link createLocalstackClient}. */
export const localstackCalls = new S3CallTracker();

export function createLocalstackClient(): S3Client {
  const client = new S3Client({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566",
    forcePathStyle: true,
    region: process.env.AWS_REGION ?? "ap-northeast-1",
  });
  return localstackCalls.instrument(client);
}

export function localstackBucket(): string {
  return process.env.S3_BUCKET ?? "claude-sessions";
}

export async function ensureLocalstackBucket(client: S3Client): Promise<void> {
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: localstackBucket(),
        CreateBucketConfiguration: {
          LocationConstraint: "ap-northeast-1",
        },
      }),
    );
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== "BucketAlreadyExists" && name !== "BucketAlreadyOwnedByYou") {
      throw error;
    }
  }
}

export async function deletePrefix(
  client: S3Client,
  prefix: string,
): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: localstackBucket(),
        ContinuationToken: continuationToken,
        Prefix: prefix,
      }),
    );
    const objects = (page.Contents ?? []).flatMap(({ Key }) =>
      Key ? [{ Key }] : [],
    );
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: localstackBucket(),
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken !== undefined);
}

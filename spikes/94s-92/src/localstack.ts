import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { S3CallTracker } from "./s3-diagnostics.ts";

export const localstackEnabled =
  process.env.SESSION_STORE_LOCALSTACK_TEST === "1";

/**
 * Without these a request LocalStack accepts and then never answers waits
 * forever: the AWS SDK's default node handler sets no timeouts, and its retry
 * policy only fires on an error that, in that state, never arrives.
 *
 * `throwOnRequestTimeout` is not optional here. With `requestTimeout` alone,
 * @smithy/node-http-handler 4.12.1 logs `a request has exceeded the configured
 * timeout` and keeps waiting — the await still never settles.
 *
 * These bound the request only. They stop at the response headers and do not
 * reach the body stream read afterwards, which is where this suite actually
 * hung; that read is bounded in `s3-session-store.ts`.
 */
export const s3RequestBounds = {
  connectionTimeout: 2_000,
  requestTimeout: 4_000,
  throwOnRequestTimeout: true,
} as const;

/** Bounded retries on top of {@link s3RequestBounds}: worst case ~13s. */
export const s3MaxAttempts = 3;

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
    maxAttempts: s3MaxAttempts,
    region: process.env.AWS_REGION ?? "ap-northeast-1",
    requestHandler: s3RequestBounds,
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

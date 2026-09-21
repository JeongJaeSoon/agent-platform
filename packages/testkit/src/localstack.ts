import { randomUUID } from "node:crypto";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

export type LocalstackEnv = {
  accessKeyId: string;
  endpoint: string;
  region: string;
  secretAccessKey: string;
};

export type LocalstackBucket = {
  bucket: string;
  /** Deletes every object under the prefix; an empty prefix empties the bucket. */
  deletePrefix(prefix: string): Promise<number>;
  /** Empties and deletes the bucket, then releases the client. */
  destroy(): Promise<void>;
  env: LocalstackEnv;
  s3: S3Client;
};

/** LocalStack tests run only when `STORAGE_LOCALSTACK_TEST=1`, as README and CI document. */
export function localstackEnabled(): boolean {
  return process.env.STORAGE_LOCALSTACK_TEST === "1";
}

export function localstackEnv(): LocalstackEnv {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "LocalStack integration environment is incomplete: AWS_ENDPOINT_URL, AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required",
    );
  }
  return { accessKeyId, endpoint, region, secretAccessKey };
}

export function localstackClient(env: LocalstackEnv = localstackEnv()) {
  return new S3Client({
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    endpoint: env.endpoint,
    forcePathStyle: true,
    region: env.region,
  });
}

export async function createLocalstackBucket(
  options: { env?: LocalstackEnv; prefix?: string } = {},
): Promise<LocalstackBucket> {
  const env = options.env ?? localstackEnv();
  const bucket = `${options.prefix ?? "testkit-it"}-${randomUUID()}`;
  const s3 = localstackClient(env);
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucket,
      CreateBucketConfiguration: {
        LocationConstraint: env.region as "ap-northeast-1",
      },
    }),
  );
  const deletePrefix = async (prefix: string) => {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: token,
          Prefix: prefix,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((object) => object.Key)
        .filter((key): key is string => typeof key === "string");
      if (keys.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return deleted;
  };
  return {
    bucket,
    deletePrefix,
    destroy: async () => {
      try {
        await deletePrefix("");
        await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally {
        s3.destroy();
      }
    },
    env,
    s3,
  };
}

export async function withLocalstackBucket<T>(
  fn: (bucket: LocalstackBucket) => Promise<T>,
  options: { env?: LocalstackEnv; prefix?: string } = {},
): Promise<T> {
  const bucket = await createLocalstackBucket(options);
  try {
    return await fn(bucket);
  } finally {
    await bucket.destroy();
  }
}

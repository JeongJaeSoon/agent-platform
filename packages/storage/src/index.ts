import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import {
  FreshAddressHttpHandler,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3RequestBounds,
} from "./s3.ts";

export * from "./checkpoint-objects.ts";
export * from "./git-runner.ts";
export * from "./git-workspace-bundle-verifier.ts";
export * from "./object-route.ts";
export {
  BodyLimitError,
  type BodyReadBounds,
  BodyStallError,
  BodyTruncatedError,
  DEFAULT_BODY_READ_BOUNDS,
  FreshAddressHttpHandler,
  MAX_BUDGETED_READ_BYTES,
  MIN_TRANSFER_BYTES_PER_SECOND,
  readBudgetMs,
  S3_MAX_ATTEMPTS,
  S3_REQUEST_BOUNDS,
  type S3ClientLike,
  type S3RequestBounds,
  transferBudgetMs,
} from "./s3.ts";
export * from "./scoped-objects.ts";

export interface StorageS3Settings {
  readonly accessKeyId: string;
  readonly endpoint?: string;
  readonly region: string;
  readonly secretAccessKey: string;
}

/**
 * The one place this package builds an S3 client, so the bounds it runs under
 * are the ones in {@link S3_REQUEST_BOUNDS}. `bounds` exists for tests that
 * cannot wait out the shipped values.
 */
export function createStorageS3Client(
  config: { readonly s3: StorageS3Settings },
  bounds: S3RequestBounds = S3_REQUEST_BOUNDS,
): S3Client {
  const s3Config: S3ClientConfig = {
    credentials: {
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey,
    },
    maxAttempts: S3_MAX_ATTEMPTS,
    region: config.s3.region,
    requestHandler: new FreshAddressHttpHandler(bounds),
    ...(config.s3.endpoint === undefined
      ? {}
      : { endpoint: config.s3.endpoint, forcePathStyle: true }),
  };
  return new S3Client(s3Config);
}

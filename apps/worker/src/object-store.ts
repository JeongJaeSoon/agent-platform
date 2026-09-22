import type { CheckpointObjectStore } from "@agent-platform/runtime-core";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  scopedCheckpointObjectStore,
} from "@agent-platform/storage";

/**
 * The one file in the worker that knows objects live in S3. Everything else
 * — the turn loop, the Claude adapter's session store — takes the
 * `CheckpointObjectStore` port, and `tests/architecture` holds the package
 * to that: `@agent-platform/storage` may be imported from here and nowhere
 * else in `apps/worker`. Wiring it into the composition root is 94S-122's
 * and 94S-246's; this file only builds the store.
 */

/**
 * What the execution backend puts in the container (`backend.ts`
 * `workerEnvironmentFor`): the bucket and endpoint the control host itself
 * uses, and the prefix this worker's session owns.
 */
export type WorkerObjectStoreEnvironment = {
  AWS_ACCESS_KEY_ID?: string | undefined;
  AWS_ENDPOINT_URL?: string | undefined;
  AWS_REGION?: string | undefined;
  AWS_SECRET_ACCESS_KEY?: string | undefined;
  S3_BUCKET?: string | undefined;
  /** `sessions/<sessionId>/`; the worker never derives it from a session id. */
  WORKER_OBJECT_PREFIX?: string | undefined;
};

export type WorkerObjectStoreConfig = {
  accessKeyId: string;
  bucket: string;
  endpoint?: string;
  region: string;
  /** Every key this worker may read or write starts with this. */
  scope: string;
  secretAccessKey: string;
};

export function objectStoreConfigFromEnv(
  environment: WorkerObjectStoreEnvironment,
): WorkerObjectStoreConfig {
  const endpoint = environment.AWS_ENDPOINT_URL?.trim();
  const scope = required(
    environment.WORKER_OBJECT_PREFIX,
    "WORKER_OBJECT_PREFIX",
  );
  if (
    !scope.endsWith("/") ||
    !scope
      .slice(0, -1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  ) {
    throw new Error(
      `WORKER_OBJECT_PREFIX ${scope} must be a key prefix ending in "/"`,
    );
  }
  if (endpoint) {
    try {
      new URL(endpoint);
    } catch {
      throw new Error(`AWS_ENDPOINT_URL ${endpoint} is not a URL`);
    }
  }
  return {
    accessKeyId: required(environment.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID"),
    bucket: required(environment.S3_BUCKET, "S3_BUCKET"),
    ...(endpoint ? { endpoint } : {}),
    region: required(environment.AWS_REGION, "AWS_REGION"),
    scope,
    secretAccessKey: required(
      environment.AWS_SECRET_ACCESS_KEY,
      "AWS_SECRET_ACCESS_KEY",
    ),
  };
}

/**
 * The store the worker's checkpoint code gets: S3 under the storage package's
 * request bounds, confined to the session prefix. The S3 client reads
 * `HTTP_PROXY`/`HTTPS_PROXY` on its own, which is how it leaves the internal
 * worker network at all.
 */
export function createWorkerObjectStore(
  config: WorkerObjectStoreConfig,
): CheckpointObjectStore {
  const client = createStorageS3Client({
    s3: {
      accessKeyId: config.accessKeyId,
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      region: config.region,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return scopedCheckpointObjectStore(
    createCheckpointObjectStore({ bucket: config.bucket, client }),
    config.scope,
  );
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

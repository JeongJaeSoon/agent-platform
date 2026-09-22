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
  endpoint: string;
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
  // The worker leaves its network only through the egress proxy, and the
  // proxy refuses the GREASE ECH that Bun's node:https puts in every
  // ClientHello (94S-219). Over https this client would therefore fail on
  // every request; refusing at startup says so once instead. Deliberately
  // minimal: lift it when the store has a transport measured to send no
  // ECH and a worker-network PUT/GET test proves it (94S-254).
  if (!endpoint) {
    throw new Error(
      "AWS_ENDPOINT_URL is required: the worker cannot reach an https object store through the egress proxy yet (94S-254)",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`AWS_ENDPOINT_URL ${endpoint} is not a URL`);
  }
  if (url.protocol !== "http:") {
    throw new Error(
      `AWS_ENDPOINT_URL ${endpoint} must be http: the worker cannot reach an https object store through the egress proxy yet (94S-254)`,
    );
  }
  return {
    accessKeyId: required(environment.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID"),
    bucket: required(environment.S3_BUCKET, "S3_BUCKET"),
    endpoint,
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
 * request bounds, confined to the session prefix.
 *
 * How it leaves the internal worker network: the storage client is a Node
 * HTTP handler, and under Bun `node:http` honours `HTTP_PROXY`/`HTTPS_PROXY`
 * itself — measured, not assumed: the egress integration test runs this
 * exact factory inside the worker network and reaches LocalStack only with
 * the proxy variables set. Under Node the same handler would ignore them
 * and need a proxy agent; the worker runs on Bun (delivery plan), so none
 * is wired. Trigger to revisit: a worker image on another runtime.
 */
export function createWorkerObjectStore(
  config: WorkerObjectStoreConfig,
): CheckpointObjectStore {
  const client = createStorageS3Client({
    s3: {
      accessKeyId: config.accessKeyId,
      endpoint: config.endpoint,
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

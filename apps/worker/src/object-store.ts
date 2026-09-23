import { isIP } from "node:net";
import type { CheckpointObjectStore } from "@agent-platform/runtime-core";
import {
  createCheckpointObjectStore,
  createStorageS3Client,
  type EgressRoute,
  type EgressRouteEnvironment,
  egressRouteFromEnv,
  S3_REQUEST_BOUNDS,
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
 * uses, the prefix this worker's session owns, and the egress proxy.
 */
export type WorkerObjectStoreEnvironment = EgressRouteEnvironment & {
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
  /**
   * How https requests leave the worker network. Absent means dial the
   * endpoint directly; the env parser always sets it.
   */
  egress?: EgressRoute;
  /** Absent means AWS itself, over https. */
  endpoint?: string;
  region: string;
  /** Every key this worker may read or write starts with this. */
  scope: string;
  secretAccessKey: string;
};

export function objectStoreConfigFromEnv(
  environment: WorkerObjectStoreEnvironment,
): WorkerObjectStoreConfig {
  const endpoint = environment.AWS_ENDPOINT_URL?.trim() || undefined;
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
  if (endpoint !== undefined) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("AWS_ENDPOINT_URL is not a URL");
    }
    // Messages quote the URL, so a credential in it is refused first and the
    // URL is never quoted with one.
    if (url.username !== "" || url.password !== "") {
      throw new Error("AWS_ENDPOINT_URL must not carry credentials");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `AWS_ENDPOINT_URL ${endpoint} must be an http:// or https:// URL`,
      );
    }
    // The https transport refuses an address on every request (see
    // `TlsTunnelHttpHandler`); saying so once at startup is kinder.
    if (
      url.protocol === "https:" &&
      isIP(url.hostname.replace(/^\[|\]$/g, ""))
    ) {
      throw new Error(
        `AWS_ENDPOINT_URL ${endpoint} must name its host: an https object store is not reached by address`,
      );
    }
  }
  return {
    accessKeyId: required(environment.AWS_ACCESS_KEY_ID, "AWS_ACCESS_KEY_ID"),
    bucket: required(environment.S3_BUCKET, "S3_BUCKET"),
    egress: egressRouteFromEnv(environment),
    ...(endpoint === undefined ? {} : { endpoint }),
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
 * How it leaves the internal worker network, measured rather than assumed —
 * the egress integration test runs this exact factory inside the worker
 * network against both kinds of endpoint:
 *
 * - https (or no endpoint: AWS): `TlsTunnelHttpHandler` opens the CONNECT
 *   tunnel to `HTTPS_PROXY` and the TLS session itself, because Bun's own
 *   https client sends a GREASE ECH the egress proxy refuses (94S-254).
 * - http: the storage client's node handler, whose `node:http` under Bun
 *   sends absolute-form requests to `HTTP_PROXY` by itself. Under Node it
 *   would ignore the variable; the worker runs on Bun (delivery plan).
 *   Trigger to revisit: a worker image on another runtime.
 */
export function createWorkerObjectStore(
  config: WorkerObjectStoreConfig,
): CheckpointObjectStore {
  const client = createStorageS3Client(
    {
      s3: {
        accessKeyId: config.accessKeyId,
        ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
        region: config.region,
        secretAccessKey: config.secretAccessKey,
      },
    },
    S3_REQUEST_BOUNDS,
    config.egress ?? { noProxy: [] },
  );
  return scopedCheckpointObjectStore(
    createCheckpointObjectStore({ bucket: config.bucket, client }),
    config.scope,
  );
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

import type { CheckpointObjectStore } from "@agent-platform/runtime-core";
import {
  createCheckpointObjectStore,
  createObjectRouteClient,
  S3_REQUEST_BOUNDS,
  scopedCheckpointObjectStore,
} from "@agent-platform/storage";

/**
 * The one file in the worker that knows objects live in S3. Everything else
 * — the turn loop, the Claude adapter's session store — takes the
 * `CheckpointObjectStore` port, and `tests/architecture` holds the package
 * to that: `@agent-platform/storage` may be imported from here and nowhere
 * else in `apps/worker`.
 */

/**
 * What the execution backend puts in the container (`backend.ts`
 * `workerEnvironmentFor`): the bucket and region, and the prefix this
 * worker's session owns. No credential: the worker reaches the object store
 * only through the egress proxy's object store route, with the token its
 * claim hands out (94S-251).
 */
export type WorkerObjectStoreEnvironment = {
  AWS_REGION?: string | undefined;
  S3_BUCKET?: string | undefined;
  /** `sessions/<sessionId>/`; the worker never derives it from a session id. */
  WORKER_OBJECT_PREFIX?: string | undefined;
};

export type WorkerObjectStoreConfig = {
  bucket: string;
  /** The egress proxy's object store route. */
  endpoint: string;
  region: string;
  /** Every key this worker may read or write starts with this. */
  scope: string;
};

export function objectStoreConfigFromEnv(
  environment: WorkerObjectStoreEnvironment,
  egressCredentialUrl: string,
): WorkerObjectStoreConfig {
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
  return {
    bucket: required(environment.S3_BUCKET, "S3_BUCKET"),
    endpoint: `${egressCredentialUrl}/object-store`,
    region: required(environment.AWS_REGION, "AWS_REGION"),
    scope,
  };
}

/**
 * The store the worker's checkpoint code gets: S3 through the route, under
 * the storage package's request bounds, confined to the session prefix.
 * The confinement is the fast failure; the route is the boundary, and it
 * refuses what the confinement would have (`object-route.ts`).
 * `token` is the claim's object store token, asked for on every request.
 */
export function createWorkerObjectStore(
  config: WorkerObjectStoreConfig,
  token: () => string,
): CheckpointObjectStore {
  const client = createObjectRouteClient(
    { endpoint: config.endpoint, region: config.region, token },
    S3_REQUEST_BOUNDS,
  );
  return scopedCheckpointObjectStore(
    createCheckpointObjectStore({ bucket: config.bucket, client }),
    config.scope,
  );
}

/**
 * The claim's object store token, handed over once the claim is in. Asked
 * for earlier, it refuses: nothing reaches the route without one.
 */
export class ObjectStoreToken {
  #value: string | null = null;

  useToken(token: string): void {
    this.#value = token;
  }

  current(): string {
    if (this.#value === null) {
      throw new Error("The object store was used before the claim");
    }
    return this.#value;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

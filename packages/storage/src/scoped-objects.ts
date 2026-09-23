import type { CheckpointObjectStore } from "@agent-platform/runtime-core";

/** No empty, `.` or `..` segment anywhere in the key. */
function plainSegments(key: string): boolean {
  return key
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A key or list prefix outside the scope this store was handed. Thrown before
 * any request leaves the process, so the object store never sees it.
 */
export class ObjectScopeError extends Error {
  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super(`Object key ${key} is outside the scope ${scope}`);
    this.name = "ObjectScopeError";
  }
}

/**
 * Confines a store to one prefix: every key must start with it, and a list
 * may only ask for keys under it. This is what a worker gets in place of an
 * IAM policy — LocalStack has none, and the credentials the worker holds can
 * reach the whole bucket. It is a client-side guard, not a credential
 * boundary: code that bypasses the wrapper still reaches everything. A
 * session-scoped credential (STS session policy on the session prefix) is
 * what closes that, and it is deferred to the deployment that has an
 * identity provider to mint it (EKS/MVM). Fencing an older generation's
 * still-valid credential is deferred with it: object keys carry the attempt,
 * not the generation, and a credential does not expire because a newer one
 * was minted.
 */
export function scopedCheckpointObjectStore(
  store: CheckpointObjectStore,
  scope: string,
): CheckpointObjectStore {
  if (!scope.endsWith("/")) {
    throw new Error(`Object scope ${scope} must end with "/"`);
  }
  if (!plainSegments(scope.slice(0, -1))) {
    throw new Error(`Object scope ${scope} is not a plain key prefix`);
  }
  function within(key: string): string {
    // Not a bare `startsWith`: "sessions/s1" would admit "sessions/s10/…".
    // The trailing slash the scope is required to carry rules that out, and
    // a key that merely names the scope directory is not an object either.
    // Dot segments are refused rather than normalized: an S3 key is a
    // string, but the request path it becomes is parsed as a URL, and
    // "s1/../s2/x" is s2's object by the time it reaches the endpoint.
    if (
      !key.startsWith(scope) ||
      key.length === scope.length ||
      !plainSegments(key)
    ) {
      throw new ObjectScopeError(scope, key);
    }
    return key;
  }
  // `async` so a refusal is a rejection like any other store failure, not a
  // synchronous throw a caller awaiting the promise would never catch.
  return {
    async get(key, version) {
      return store.get(within(key), version);
    },
    async head(key, version) {
      return store.head(within(key), version);
    },
    async list(prefix) {
      // A list prefix may be the scope itself or anything under it, and it
      // usually ends in a slash, which is not an empty segment.
      const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      if (prefix !== scope) within(trimmed);
      return store.list(prefix);
    },
    async put(key, bytes) {
      return store.put(within(key), bytes);
    },
    async putImmutable(key, bytes) {
      return store.putImmutable(within(key), bytes);
    },
    // No `hold`: only the control plane places holds, on what it committed.
  };
}

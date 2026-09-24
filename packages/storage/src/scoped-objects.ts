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
 * Whether `key` names an object under `scope`. Not a bare `startsWith`:
 * "sessions/s1" would admit "sessions/s10/…". The trailing slash the scope
 * is required to carry rules that out, and a key that merely names the scope
 * directory is not an object either. Dot segments are refused rather than
 * normalized: an S3 key is a string, but the request path it becomes is
 * parsed as a URL, and "s1/../s2/x" is s2's object by the time it reaches
 * the endpoint.
 */
export function objectKeyWithin(scope: string, key: string): boolean {
  return (
    key.startsWith(scope) && key.length > scope.length && plainSegments(key)
  );
}

/**
 * A list prefix a store confined to `scope` may ask for: the scope itself,
 * or anything under it. It usually ends in a slash, which is not an empty
 * segment.
 */
export function listPrefixWithin(scope: string, prefix: string): boolean {
  if (prefix === scope) return true;
  return objectKeyWithin(
    scope,
    prefix.endsWith("/") ? prefix.slice(0, -1) : prefix,
  );
}

/**
 * Confines a store to one prefix: every key must start with it, and a list
 * may only ask for keys under it. The boundary itself is the object store
 * route (94S-251): the worker holds no object store credential, and the
 * route signs only requests under its session's prefix. This guard is the
 * fast failure in front of it, so a stray key is refused in the process
 * that made it rather than after a round trip.
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
    if (!objectKeyWithin(scope, key)) {
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
    async stream(key, version) {
      return store.stream(within(key), version);
    },
    async list(prefix) {
      if (!listPrefixWithin(scope, prefix)) {
        throw new ObjectScopeError(scope, prefix);
      }
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

import { createHash } from "node:crypto";
import type {
  CheckpointObjectStore,
  PutImmutableResult,
} from "@agent-platform/runtime-core";

export type MemoryCheckpointObjectStore = CheckpointObjectStore & {
  /** Keys written, in insertion order. */
  keys(): string[];
  /** Fails the next `n` writes of any kind, to exercise mirror failures. */
  failWrites(count: number): void;
  /** Drops an object, standing in for a lifecycle rule or an operator delete. */
  remove(key: string): void;
  /** Keys whose bodies were fetched since the last reset, in call order. */
  reads(): string[];
  resetReads(): void;
};

/**
 * In-memory checkpoint object store with the create-only semantics the S3
 * adapter implements, so unit tests can exercise the immutability contract
 * without LocalStack.
 */
export function createMemoryCheckpointObjectStore(): MemoryCheckpointObjectStore {
  const objects = new Map<string, Uint8Array>();
  const reads: string[] = [];
  let failuresLeft = 0;

  function guardWrite(key: string): void {
    if (failuresLeft <= 0) return;
    failuresLeft -= 1;
    throw new Error(`Injected object store failure: ${key}`);
  }

  return {
    async get(key) {
      reads.push(key);
      const stored = objects.get(key);
      return stored === undefined ? undefined : stored.slice();
    },

    async head(key) {
      const stored = objects.get(key);
      return stored === undefined ? undefined : { bytes: stored.byteLength };
    },

    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },

    async put(key, bytes) {
      guardWrite(key);
      objects.set(key, bytes.slice());
    },

    async putImmutable(key, bytes): Promise<PutImmutableResult> {
      guardWrite(key);
      const existing = objects.get(key);
      if (existing === undefined) {
        objects.set(key, bytes.slice());
        return { outcome: "created" };
      }
      const found = sha256(existing);
      return found === sha256(bytes)
        ? { outcome: "duplicate" }
        : { outcome: "conflict", sha256: found };
    },

    keys() {
      return [...objects.keys()];
    },

    failWrites(count) {
      failuresLeft = count;
    },

    remove(key) {
      objects.delete(key);
    },

    reads() {
      return [...reads];
    },

    resetReads() {
      reads.length = 0;
    },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

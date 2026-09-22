import type {
  CheckpointObjectStore,
  PutImmutableResult,
} from "@agent-platform/runtime-core";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

import {
  bodyBytes,
  isConditionalConflict,
  isMissingObject,
  isPreconditionFailed,
  type S3ClientLike,
  sha256,
} from "./s3.ts";

// Bounded: a 409 means retry, but an endpoint that answers 409 forever must
// surface as a failure rather than an unbounded loop inside a mirror write.
const CONFLICT_ATTEMPTS = 4;

export type CheckpointObjectStoreOptions = {
  readonly bucket: string;
  readonly client: S3ClientLike;
};

/**
 * S3-backed checkpoint objects.
 *
 * `putImmutable` is the reason this exists: a worker whose lease has already
 * been taken over may still be holding a manifest upload. `If-None-Match: *`
 * makes that upload fail instead of replacing the body the live worker wrote,
 * and the 412 path reads the stored bytes back so a retry of the *same* body
 * reports `duplicate` rather than a false conflict.
 */
export function createCheckpointObjectStore(
  options: CheckpointObjectStoreOptions,
): CheckpointObjectStore {
  const { bucket, client } = options;

  async function get(key: string): Promise<Uint8Array | undefined> {
    try {
      const response = (await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )) as { Body?: unknown };
      if (response.Body === undefined) {
        throw new Error(`S3 object has no body: ${key}`);
      }
      return bodyBytes(response.Body);
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      throw error;
    }
  }

  function compare(stored: Uint8Array, expected: string): PutImmutableResult {
    const found = sha256(stored);
    return found === expected
      ? { outcome: "duplicate" }
      : { outcome: "conflict", sha256: found };
  }

  return {
    get,

    async head(key) {
      try {
        const response = (await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        )) as { ContentLength?: number };
        return { bytes: response.ContentLength ?? 0 };
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        throw error;
      }
    },

    async list(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = (await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
            Prefix: prefix,
          }),
        )) as {
          Contents?: Array<{ Key?: string }>;
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) keys.push(object.Key);
        }
        continuationToken = page.IsTruncated
          ? page.NextContinuationToken
          : undefined;
      } while (continuationToken !== undefined);
      return keys.sort();
    },

    async put(key, bytes) {
      await client.send(
        new PutObjectCommand({ Body: bytes, Bucket: bucket, Key: key }),
      );
    },

    async putImmutable(key, bytes) {
      const expected = sha256(bytes);
      // The read is not the guarantee — the precondition below is — but it
      // keeps an endpoint that silently ignores If-None-Match from turning a
      // late upload into an overwrite outside the narrow concurrent window.
      const existing = await get(key);
      if (existing !== undefined) return compare(existing, expected);
      for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
        try {
          await client.send(
            new PutObjectCommand({
              Body: bytes,
              Bucket: bucket,
              IfNoneMatch: "*",
              Key: key,
            }),
          );
          return { outcome: "created" };
        } catch (error) {
          if (isPreconditionFailed(error)) {
            const stored = await get(key);
            // Rejected, yet nothing is stored: a lifecycle rule or a delete,
            // not a second writer. Refuse rather than retry; the caller keeps
            // its pointer.
            return stored === undefined
              ? { outcome: "conflict", sha256: "" }
              : compare(stored, expected);
          }
          if (!isConditionalConflict(error)) throw error;
          // 409 says the write overlapped another conditional write, not that
          // this one lost. If the winner already stored something, that is the
          // answer; otherwise nobody holds the key yet and the retry stands.
          const stored = await get(key);
          if (stored !== undefined) return compare(stored, expected);
        }
      }
      // Never report "created" for a write that was not observed to land.
      throw new Error(`Conditional write to ${key} kept conflicting`);
    },
  };
}

import type {
  CheckpointObjectStore,
  PutImmutableResult,
} from "@agent-platform/runtime-core";
import {
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
} from "@aws-sdk/client-s3";

import {
  type BodyReadBounds,
  getObjectVersion,
  isConditionalConflict,
  isMissingObject,
  isPreconditionFailed,
  isUnreadableVersion,
  type S3ClientLike,
  sha256,
  storedVersion,
  streamObjectVersion,
} from "./s3.ts";

// Bounded: a 409 means retry, but an endpoint that answers 409 forever must
// surface as a failure rather than an unbounded loop inside a mirror write.
const CONFLICT_ATTEMPTS = 4;

export type CheckpointObjectStoreOptions = {
  /** Defaults to `DEFAULT_BODY_READ_BOUNDS`; tests pin shorter bounds. */
  readonly bodyRead?: BodyReadBounds;
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
 *
 * On a versioned bucket every write answers with its VersionId and every read
 * can ask for one; `hold` places an Object Lock legal hold, which needs a
 * bucket with Object Lock enabled. On a bucket without versioning none of
 * that is reported and asking for a version finds nothing.
 */
export function createCheckpointObjectStore(
  options: CheckpointObjectStoreOptions,
): CheckpointObjectStore {
  const { bodyRead, bucket, client } = options;

  function read(key: string, version?: string) {
    return getObjectVersion(client, bucket, key, {
      ...(bodyRead === undefined ? {} : { bounds: bodyRead }),
      ...(version === undefined ? {} : { version }),
    });
  }

  function compare(
    stored: { bytes: Uint8Array; version?: string },
    expected: string,
  ): PutImmutableResult {
    const found = sha256(stored.bytes);
    if (found !== expected) return { outcome: "conflict", sha256: found };
    return stored.version === undefined
      ? { outcome: "duplicate" }
      : { outcome: "duplicate", version: stored.version };
  }

  return {
    async get(key, version) {
      return (await read(key, version))?.bytes;
    },

    async stream(key, version) {
      const found = await streamObjectVersion(client, bucket, key, {
        ...(bodyRead === undefined ? {} : { bounds: bodyRead }),
        ...(version === undefined ? {} : { version }),
      });
      return found?.chunks;
    },

    async head(key, version) {
      try {
        const response = (await client.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
            VersionId: version,
          }),
        )) as {
          ContentLength?: number;
          ObjectLockLegalHoldStatus?: "ON" | "OFF";
          VersionId?: string;
        };
        const found = storedVersion(response.VersionId);
        return {
          bytes: response.ContentLength ?? 0,
          ...(response.ObjectLockLegalHoldStatus === "ON"
            ? { held: true }
            : {}),
          ...(found === undefined ? {} : { version: found }),
        };
      } catch (error) {
        if (isMissingObject(error)) return undefined;
        if (version !== undefined && isUnreadableVersion(error))
          return undefined;
        throw error;
      }
    },

    async hold(key, version) {
      await client.send(
        new PutObjectLegalHoldCommand({
          Bucket: bucket,
          Key: key,
          LegalHold: { Status: "ON" },
          VersionId: version,
        }),
      );
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
      const existing = await read(key);
      if (existing !== undefined) return compare(existing, expected);
      for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
        try {
          const response = (await client.send(
            new PutObjectCommand({
              Body: bytes,
              Bucket: bucket,
              IfNoneMatch: "*",
              Key: key,
            }),
          )) as { VersionId?: string };
          const version = storedVersion(response.VersionId);
          return version === undefined
            ? { outcome: "created" }
            : { outcome: "created", version };
        } catch (error) {
          if (isPreconditionFailed(error)) {
            const stored = await read(key);
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
          const stored = await read(key);
          if (stored !== undefined) return compare(stored, expected);
        }
      }
      // Never report "created" for a write that was not observed to land.
      throw new Error(`Conditional write to ${key} kept conflicting`);
    },
  };
}

export type BucketProtection = {
  /** True when the bucket has an Object Lock configuration, so holds work. */
  readonly objectLock: boolean;
  readonly versioning: "Enabled" | "Suspended" | "Off";
};

/**
 * What a bucket can promise a checkpoint: whether its writes get versions,
 * and whether a version can be held. Read at startup, so a deployment that
 * requires both finds out before the first finalize rather than on it.
 */
export async function describeBucketProtection(
  client: S3ClientLike,
  bucket: string,
): Promise<BucketProtection> {
  const versioning = (await client.send(
    new GetBucketVersioningCommand({ Bucket: bucket }),
  )) as { Status?: string };
  let objectLock = false;
  try {
    const found = (await client.send(
      new GetObjectLockConfigurationCommand({ Bucket: bucket }),
    )) as { ObjectLockConfiguration?: { ObjectLockEnabled?: string } };
    objectLock = found.ObjectLockConfiguration?.ObjectLockEnabled === "Enabled";
  } catch (error) {
    if (!isMissingLockConfiguration(error)) throw error;
  }
  return {
    objectLock,
    versioning:
      versioning.Status === "Enabled" || versioning.Status === "Suspended"
        ? versioning.Status
        : "Off",
  };
}

function isMissingLockConfiguration(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "ObjectLockConfigurationNotFoundError";
}

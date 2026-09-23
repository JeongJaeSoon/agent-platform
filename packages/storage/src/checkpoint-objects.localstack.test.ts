import { expect, test } from "bun:test";
import {
  localstackEnabled,
  withLocalstackBucket,
} from "@agent-platform/testkit/localstack";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  createCheckpointObjectStore,
  describeBucketProtection,
} from "./checkpoint-objects.ts";
import {
  ObjectScopeError,
  scopedCheckpointObjectStore,
} from "./scoped-objects.ts";

const localstackTest = localstackEnabled() ? test : test.skip;

localstackTest(
  "a manifest key is create-only against a real S3 endpoint",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/checkpoints/0000000000/manifest.json";
        const published = encode('{"revision":0,"resume":"live"}\n');

        expect(await store.putImmutable(key, published)).toEqual({
          outcome: "created",
        });
        // The same worker retrying its own upload is not a conflict.
        expect(await store.putImmutable(key, published)).toEqual({
          outcome: "duplicate",
        });
        // A worker from the previous epoch finishing its upload is.
        const stale = await store.putImmutable(
          key,
          encode('{"revision":0,"resume":"stale"}\n'),
        );
        expect(stale.outcome).toBe("conflict");
        expect(await store.get(key)).toEqual(published);
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

localstackTest(
  "lists a session's checkpoint objects in revision order",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        for (const revision of [2, 0, 1]) {
          await store.putImmutable(
            `sessions/s1/checkpoints/${String(revision).padStart(10, "0")}/manifest.json`,
            encode(`{"revision":${revision}}\n`),
          );
        }
        await store.put(
          "sessions/s2/checkpoints/0000000000/manifest.json",
          encode("{}"),
        );

        expect(await store.list("sessions/s1/checkpoints/")).toEqual([
          "sessions/s1/checkpoints/0000000000/manifest.json",
          "sessions/s1/checkpoints/0000000001/manifest.json",
          "sessions/s1/checkpoints/0000000002/manifest.json",
        ]);
        expect(
          await store.get("sessions/s1/checkpoints/0000000009/manifest.json"),
        ).toBeUndefined();
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// The store also reads before it writes, which would mask an endpoint that
// ignores the precondition. This asserts the precondition itself, because it is
// the only thing that holds under two workers uploading at once.
localstackTest(
  "the endpoint enforces the create-only precondition itself",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const key = "sessions/s1/checkpoints/0000000000/manifest.json";
        await s3.send(
          new PutObjectCommand({
            Body: encode("live"),
            Bucket: bucket,
            Key: key,
          }),
        );

        const refused = await s3
          .send(
            new PutObjectCommand({
              Body: encode("stale"),
              Bucket: bucket,
              IfNoneMatch: "*",
              Key: key,
            }),
          )
          .then(
            () => undefined,
            (error: { $metadata?: { httpStatusCode?: number } }) => error,
          );

        expect(refused?.$metadata?.httpStatusCode).toBe(412);
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

function encode(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

// The worker holds bucket-wide credentials and is confined to its session by
// the wrapper alone; see `scopedCheckpointObjectStore` for why that is not a
// credential boundary. This shows the confinement against the real endpoint:
// another session's object is out of reach even though the key exists.
localstackTest(
  "a session-scoped store reaches its own prefix and nothing else",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const unscoped = createCheckpointObjectStore({ bucket, client: s3 });
        const own = "sessions/s1/checkpoints/0000000000/a1/manifest.json";
        const foreign = "sessions/s2/checkpoints/0000000000/a1/manifest.json";
        await unscoped.put(foreign, encode("{}"));

        const scoped = scopedCheckpointObjectStore(unscoped, "sessions/s1/");
        expect(
          await scoped.putImmutable(own, encode('{"revision":0}')),
        ).toEqual({ outcome: "created" });
        expect(await scoped.get(own)).toEqual(encode('{"revision":0}'));
        expect(await scoped.list("sessions/s1/")).toEqual([own]);

        await expect(scoped.get(foreign)).rejects.toThrow(ObjectScopeError);
        await expect(scoped.put(foreign, encode("x"))).rejects.toThrow(
          ObjectScopeError,
        );
        await expect(scoped.list("sessions/")).rejects.toThrow(
          ObjectScopeError,
        );
        // Untouched: the refusal happened before any request was sent.
        expect(await unscoped.get(foreign)).toEqual(encode("{}"));
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

// 94S-229, against the real endpoint: a version is what a checkpoint names,
// so what the key holds later — an overwrite, a delete marker, a create-only
// write landing again behind the marker — cannot reach it, and a held version
// cannot be deleted by anyone who has not released the hold.
localstackTest(
  "a versioned Object Lock bucket answers versions, reads them back and refuses to delete a held one",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/mirror/part-0000000000.jsonl";
        expect(await describeBucketProtection(s3, bucket)).toEqual({
          objectLock: true,
          versioning: "Enabled",
        });

        const created = await store.putImmutable(key, encode("one\n"));
        expect(created).toEqual({
          outcome: "created",
          version: expect.any(String),
        });
        const version = (created as { version: string }).version;
        // A retry of the same bytes names the write that already landed.
        expect(await store.putImmutable(key, encode("one\n"))).toEqual({
          outcome: "duplicate",
          version,
        });

        await store.put(key, encode("two\n"));
        expect(await store.get(key)).toEqual(encode("two\n"));
        expect(await store.get(key, version)).toEqual(encode("one\n"));
        expect(await store.head(key, version)).toEqual({ bytes: 4, version });

        await store.hold?.(key, version);
        expect(await store.head(key, version)).toEqual({
          bytes: 4,
          held: true,
          version,
        });
        const refused = await s3
          .send(
            new DeleteObjectCommand({
              Bucket: bucket,
              BypassGovernanceRetention: true,
              Key: key,
              VersionId: version,
            }),
          )
          .then(
            () => undefined,
            (error: { $metadata?: { httpStatusCode?: number } }) => error,
          );
        expect(refused?.$metadata?.httpStatusCode).toBe(403);

        // A delete marker hides the key and lets create-only land again,
        // and neither touches the version a checkpoint names.
        const marker = (await s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        )) as { DeleteMarker?: boolean; VersionId?: string };
        expect(marker.DeleteMarker).toBe(true);
        expect(await store.get(key)).toBeUndefined();
        // A manifest naming the marker's own id names nothing readable: S3
        // answers 405 there, which is absence, not an outage to retry.
        expect(await store.head(key, marker.VersionId)).toBeUndefined();
        expect(await store.get(key, marker.VersionId)).toBeUndefined();
        const reused = await store.putImmutable(key, encode("three\n"));
        expect(reused.outcome).toBe("created");
        expect(await store.get(key, version)).toEqual(encode("one\n"));

        // A version the bucket never issued reads as absent, not as an outage.
        expect(await store.get(key, "no-such-version")).toBeUndefined();
        expect(await store.head(key, "no-such-version")).toBeUndefined();
      },
      { objectLock: true, prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

localstackTest(
  "a bucket without versioning reports none, and cannot hold",
  async () => {
    await withLocalstackBucket(
      async ({ bucket, s3 }) => {
        const store = createCheckpointObjectStore({ bucket, client: s3 });
        const key = "sessions/s1/mirror/part-0000000000.jsonl";
        expect(await describeBucketProtection(s3, bucket)).toEqual({
          objectLock: false,
          versioning: "Off",
        });
        expect(await store.putImmutable(key, encode("one\n"))).toEqual({
          outcome: "created",
        });
        expect(await store.head(key)).toEqual({ bytes: 4 });
        expect(await store.get(key, "some-version")).toBeUndefined();
        await expect(store.hold?.(key, "null")).rejects.toThrow();
      },
      { prefix: "checkpoint-objects-it" },
    );
  },
  30_000,
);

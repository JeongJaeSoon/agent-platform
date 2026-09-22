import { expect, test } from "bun:test";
import {
  localstackEnabled,
  withLocalstackBucket,
} from "@agent-platform/testkit/localstack";
import { PutObjectCommand } from "@aws-sdk/client-s3";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";

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

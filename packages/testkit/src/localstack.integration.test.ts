import { expect, test } from "bun:test";
import {
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createLocalstackBucket,
  localstackClient,
  localstackEnabled,
  localstackEnv,
} from "./localstack.ts";

const localstackTest = localstackEnabled() ? test : test.skip;

localstackTest(
  "creates a bucket, clears a prefix and destroys the bucket",
  async () => {
    const fixture = await createLocalstackBucket({ prefix: "testkit-it" });
    const { bucket, s3 } = fixture;
    let destroyed = false;
    try {
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: "a/one", Body: "1" }),
      );
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: "a/two", Body: "2" }),
      );
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: "b/keep", Body: "3" }),
      );

      expect(await fixture.deletePrefix("a/")).toBe(2);
      const remaining = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      expect(remaining.Contents?.map((object) => object.Key)).toEqual([
        "b/keep",
      ]);

      await fixture.destroy();
      destroyed = true;
    } finally {
      if (!destroyed) await fixture.destroy();
    }
    const probe = localstackClient(localstackEnv());
    try {
      await expect(
        probe.send(new HeadBucketCommand({ Bucket: bucket })),
      ).rejects.toThrow();
    } finally {
      probe.destroy();
    }
  },
  30_000,
);

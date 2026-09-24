import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  createCheckpointObjectStore,
  describeBucketEncryption,
} from "./checkpoint-objects.ts";
import type { S3ClientLike } from "./s3.ts";

type Command = {
  input: Record<string, unknown>;
  constructor: { name: string };
};

/**
 * Minimal S3 that enforces the two behaviours the checkpoint contract rests on:
 * `If-None-Match: *` fails with 412 when the key exists, and a missing key
 * fails with NoSuchKey.
 */
function fakeS3(
  initial: Record<string, string> = {},
  options: { conflicts?: number } = {},
) {
  const objects = new Map<string, Uint8Array>(
    Object.entries(initial).map(([key, body]) => [key, encode(body)]),
  );
  const calls: string[] = [];
  let conflicts = options.conflicts ?? 0;
  const client: S3ClientLike = {
    async send(command) {
      const { input } = command as Command;
      const name = commandName(command);
      calls.push(name);
      const key = input.Key as string;
      switch (name) {
        case "PutObjectCommand": {
          if (input.IfNoneMatch === "*" && conflicts > 0) {
            conflicts -= 1;
            throw Object.assign(new Error("conditional request conflict"), {
              name: "ConditionalRequestConflict",
              $metadata: { httpStatusCode: 409 },
            });
          }
          if (input.IfNoneMatch === "*" && objects.has(key)) {
            throw Object.assign(
              new Error("At least one of the pre-conditions"),
              {
                name: "PreconditionFailed",
                $metadata: { httpStatusCode: 412 },
              },
            );
          }
          objects.set(key, new Uint8Array(input.Body as Uint8Array));
          return {};
        }
        case "GetObjectCommand": {
          const stored = objects.get(key);
          if (stored === undefined) {
            throw Object.assign(new Error("no such key"), {
              name: "NoSuchKey",
              $metadata: { httpStatusCode: 404 },
            });
          }
          return { Body: { transformToByteArray: async () => stored } };
        }
        case "ListObjectsV2Command": {
          const prefix = input.Prefix as string;
          return {
            Contents: [...objects.keys()]
              .filter((candidate) => candidate.startsWith(prefix))
              .map((Key) => ({ Key })),
            IsTruncated: false,
          };
        }
        default:
          throw new Error(`Unexpected command: ${name}`);
      }
    },
  };
  return { calls, client, objects };
}

function commandName(command: unknown): string {
  return (command as Command).constructor.name;
}

function encode(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

function sha256(body: string): string {
  return createHash("sha256").update(encode(body)).digest("hex");
}

describe("checkpoint object store", () => {
  test("creates an object that does not exist yet", async () => {
    const s3 = fakeS3();
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(await store.putImmutable("m.json", encode("first"))).toEqual({
      outcome: "created",
    });
    expect(await store.get("m.json")).toEqual(encode("first"));
  });

  test("reports the same bytes under the same key as a duplicate, not a failure", async () => {
    const s3 = fakeS3({ "m.json": "first" });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(await store.putImmutable("m.json", encode("first"))).toEqual({
      outcome: "duplicate",
    });
  });

  test("retries a conditional write the endpoint answered with 409", async () => {
    // S3 answers overlapping conditional writes with 409
    // ConditionalRequestConflict, which its contract says to retry. Treating
    // it as fatal would surface an ordinary slot race as a mirror failure.
    const s3 = fakeS3({}, { conflicts: 2 });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(await store.putImmutable("m.json", encode("first"))).toEqual({
      outcome: "created",
    });
    expect(await store.get("m.json")).toEqual(encode("first"));
  });

  test("takes the winner's bytes when a 409 race was already settled", async () => {
    const s3 = fakeS3({}, { conflicts: 1 });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });
    // The writer that won the race stores its body while this one is retrying.
    s3.objects.set("m.json", encode("winner"));

    expect(await store.putImmutable("m.json", encode("loser"))).toEqual({
      outcome: "conflict",
      sha256: sha256("winner"),
    });
  });

  test("never reports created when 409 never stops", async () => {
    const s3 = fakeS3({}, { conflicts: 99 });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(store.putImmutable("m.json", encode("first"))).rejects.toThrow(
      /kept conflicting/,
    );
  });

  test("refuses different bytes under a key that already exists", async () => {
    const s3 = fakeS3({ "m.json": "first" });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(await store.putImmutable("m.json", encode("second"))).toEqual({
      outcome: "conflict",
      sha256: sha256("first"),
    });
    // The point of the refusal: the first writer's manifest is still intact.
    expect(await store.get("m.json")).toEqual(encode("first"));
  });

  test("still refuses when the endpoint ignores the create-only precondition", async () => {
    const s3 = fakeS3({ "m.json": "first" });
    const permissive: S3ClientLike = {
      send: (command) => {
        const { input } = command as Command;
        delete input.IfNoneMatch;
        return s3.client.send(command);
      },
    };
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: permissive,
    });

    expect(await store.putImmutable("m.json", encode("second"))).toMatchObject({
      outcome: "conflict",
    });
    expect(await store.get("m.json")).toEqual(encode("first"));
  });

  test("writes a content-addressed key with one request, no read before it (94S-380)", async () => {
    const s3 = fakeS3();
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(
      await store.putImmutable("untracked/x", encode("first"), {
        contentAddressed: true,
      }),
    ).toEqual({ outcome: "created" });
    expect(s3.calls).toEqual(["PutObjectCommand"]);
  });

  test("a content-addressed key still answers duplicate and conflict through the precondition", async () => {
    const s3 = fakeS3({ same: "first", other: "first" });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(
      await store.putImmutable("same", encode("first"), {
        contentAddressed: true,
      }),
    ).toEqual({ outcome: "duplicate" });
    expect(
      await store.putImmutable("other", encode("second"), {
        contentAddressed: true,
      }),
    ).toEqual({ outcome: "conflict", sha256: sha256("first") });
    expect(s3.calls).toEqual([
      "PutObjectCommand",
      "GetObjectCommand",
      "PutObjectCommand",
      "GetObjectCommand",
    ]);
  });

  test("sends the create-only precondition on the write it attempts", async () => {
    const s3 = fakeS3();
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });
    let precondition: unknown;
    const recording: S3ClientLike = {
      send: (command) => {
        const { input } = command as Command;
        if (commandName(command) === "PutObjectCommand") {
          precondition = input.IfNoneMatch;
        }
        return s3.client.send(command);
      },
    };

    await createCheckpointObjectStore({
      bucket: "b",
      client: recording,
    }).putImmutable("m.json", encode("first"));

    expect(precondition).toBe("*");
    expect(await store.get("m.json")).toEqual(encode("first"));
  });

  test("get answers undefined for a key that was never written", async () => {
    const s3 = fakeS3();
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(await store.get("absent")).toBeUndefined();
  });

  test("list returns the keys under a prefix in order", async () => {
    const s3 = fakeS3({ "a/2": "", "a/1": "", "b/1": "" });
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    expect(await store.list("a/")).toEqual(["a/1", "a/2"]);
  });

  test("put replaces freely, because mirror parts own their key uniqueness", async () => {
    const s3 = fakeS3();
    const store = createCheckpointObjectStore({
      bucket: "b",
      client: s3.client,
    });

    await store.put("part", encode("one"));
    await store.put("part", encode("two"));

    expect(await store.get("part")).toEqual(encode("two"));
  });
});

describe("bucket default encryption", () => {
  const answering = (answer: () => unknown): S3ClientLike => ({
    async send(command) {
      expect(commandName(command)).toBe("GetBucketEncryptionCommand");
      return answer();
    },
  });
  const rule = (SSEAlgorithm: string) => ({
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm } }],
    },
  });

  test("reports the algorithm of the default rule", async () => {
    expect(
      await describeBucketEncryption(
        answering(() => rule("AES256")),
        "b",
      ),
    ).toBe("AES256");
    expect(
      await describeBucketEncryption(
        answering(() => rule("aws:kms")),
        "b",
      ),
    ).toBe("aws:kms");
  });

  test("reports none for a bucket without an encryption configuration", async () => {
    const missing = answering(() => {
      throw Object.assign(new Error("not found"), {
        name: "ServerSideEncryptionConfigurationNotFoundError",
      });
    });
    expect(await describeBucketEncryption(missing, "b")).toBe("none");
    expect(
      await describeBucketEncryption(
        answering(() => ({})),
        "b",
      ),
    ).toBe("none");
  });

  test("does not read a refused lookup as a bucket without encryption", async () => {
    const denied = answering(() => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    });
    await expect(describeBucketEncryption(denied, "b")).rejects.toThrow(
      "denied",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createCheckpointObjectStore } from "./checkpoint-objects.ts";
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
function fakeS3(initial: Record<string, string> = {}) {
  const objects = new Map<string, Uint8Array>(
    Object.entries(initial).map(([key, body]) => [key, encode(body)]),
  );
  const calls: string[] = [];
  const client: S3ClientLike = {
    async send(command) {
      const { input } = command as Command;
      const name = commandName(command);
      calls.push(name);
      const key = input.Key as string;
      switch (name) {
        case "PutObjectCommand": {
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

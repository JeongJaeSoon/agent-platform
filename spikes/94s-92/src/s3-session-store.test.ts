import { describe, expect, test } from "bun:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { runSessionStoreConformance } from "./conformance.ts";
import { MemoryS3Client } from "./memory-s3.ts";
import { S3SessionStoreProbe } from "./s3-session-store.ts";

describe("S3SessionStoreProbe official conformance", () => {
  runSessionStoreConformance(() => createStore(new MemoryS3Client()));
});

test("deduplicates stable UUIDs while retaining entries without UUIDs", async () => {
  const store = createStore(new MemoryS3Client());
  const key = { projectKey: "tenant-project", sessionId: "session-a" };
  const stable = { type: "user", uuid: "stable-uuid", value: 1 };
  const marker = { type: "mode", value: "plan" };

  await store.append(key, [stable, marker]);
  await store.append(key, [stable, marker]);

  expect(await store.load(key)).toEqual([stable, marker, marker]);
});

test("rejects conflicting payloads for one stable UUID", async () => {
  const store = createStore(new MemoryS3Client());
  const key = { projectKey: "tenant-project", sessionId: "session-a" };
  await store.append(key, [{ type: "user", uuid: "same", value: 1 }]);
  await store.append(key, [{ type: "user", uuid: "same", value: 2 }]);

  await expect(store.load(key)).rejects.toThrow(
    "Conflicting SessionStore UUID: same",
  );
});

test("accepts deep-equal UUID retries with different object key order", async () => {
  const store = createStore(new MemoryS3Client());
  const key = { projectKey: "tenant-project", sessionId: "session-a" };
  await store.append(key, [
    { type: "user", uuid: "same", nested: { first: 1, second: 2 } },
  ]);
  await store.append(key, [
    { nested: { second: 2, first: 1 }, uuid: "same", type: "user" },
  ]);

  expect(await store.load(key)).toEqual([
    { type: "user", uuid: "same", nested: { first: 1, second: 2 } },
  ]);
});

test("pins an immutable recoverable revision separately from the latest mirror suffix", async () => {
  const store = createStore(new MemoryS3Client());
  const key = { projectKey: "tenant-project", sessionId: "session-a" };
  const safe = { type: "assistant", uuid: "safe", value: "checkpoint" };
  const suffix = { type: "assistant", uuid: "suffix", value: "not-published" };

  await store.append(key, [safe]);
  const revision = await store.captureRevision(key);
  expect(revision).not.toBeNull();
  if (!revision) throw new Error("Revision was not captured");
  await store.append(key, [suffix]);

  expect(await store.load(key)).toEqual([safe, suffix]);
  expect(await store.loadRevision(revision)).toEqual([safe]);
});

test("rejects tampering in a pinned revision", async () => {
  const client = new MemoryS3Client();
  const store = createStore(client);
  const key = { projectKey: "tenant-project", sessionId: "session-a" };
  await store.append(key, [{ type: "user", uuid: "safe" }]);
  const revision = await store.captureRevision(key);
  const part = revision?.parts[0];
  expect(part).toBeDefined();
  if (!revision || !part) throw new Error("Revision part was not captured");
  client.objects.set(
    part.key,
    new TextEncoder().encode('{"type":"user","uuid":"tampered"}\n'),
  );

  await expect(store.loadRevision(revision)).rejects.toThrow(
    "SessionStore revision integrity failure",
  );
});

test("rejects a modified revision part list before loading objects", async () => {
  const store = createStore(new MemoryS3Client());
  const key = { projectKey: "tenant-project", sessionId: "session-a" };
  await store.append(key, [{ type: "user", uuid: "safe" }]);
  const revision = await store.captureRevision(key);
  if (!revision) throw new Error("Revision was not captured");

  await expect(
    store.loadRevision({
      ...revision,
      parts: [...revision.parts, { key: "injected", sha256: "0".repeat(64) }],
    }),
  ).rejects.toThrow("SessionStore revision manifest digest mismatch");
});

test("isolates two sessions sharing the same workspace key", async () => {
  const store = createStore(new MemoryS3Client());
  const first = { projectKey: "workspace", sessionId: "first" };
  const second = { projectKey: "workspace", sessionId: "second" };
  await store.append(first, [{ type: "user", uuid: "first-message" }]);
  await store.append(second, [{ type: "user", uuid: "second-message" }]);

  expect(await store.load(first)).toEqual([
    { type: "user", uuid: "first-message" },
  ]);
  expect(await store.load(second)).toEqual([
    { type: "user", uuid: "second-message" },
  ]);
});

test("does not expose a failed append as a revision", async () => {
  const client = new MemoryS3Client();
  client.failPuts = 1;
  const store = createStore(client);
  const key = { projectKey: "workspace", sessionId: "failed" };

  await expect(
    store.append(key, [{ type: "user", uuid: "not-durable" }]),
  ).rejects.toThrow("injected PutObject failure");
  expect(await store.captureRevision(key)).toBeNull();
});

function createStore(client: MemoryS3Client): S3SessionStoreProbe {
  return new S3SessionStoreProbe({
    bucket: "test-bucket",
    client: client as unknown as Pick<S3Client, "send">,
    prefix: "probe",
  });
}

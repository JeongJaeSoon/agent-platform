import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runSessionStoreConformance } from "./conformance.ts";
import {
  createLocalstackClient,
  deletePrefix,
  ensureLocalstackBucket,
  localstackBucket,
  localstackEnabled,
} from "./localstack.ts";
import { S3SessionStoreProbe } from "./s3-session-store.ts";

const describeLocalstack = localstackEnabled ? describe : describe.skip;

describeLocalstack("S3SessionStoreProbe with LocalStack", () => {
  const client = createLocalstackClient();
  const rootPrefix = `94s-92/conformance-${crypto.randomUUID()}`;
  let factoryIndex = 0;

  beforeAll(async () => {
    await ensureLocalstackBucket(client);
  });

  afterAll(async () => {
    await deletePrefix(client, rootPrefix);
    client.destroy();
  });

  runSessionStoreConformance(
    () =>
      new S3SessionStoreProbe({
        bucket: localstackBucket(),
        client,
        prefix: `${rootPrefix}/${factoryIndex++}`,
      }),
  );

  test("pins exact part hashes on real S3-compatible storage", async () => {
    const store = new S3SessionStoreProbe({
      bucket: localstackBucket(),
      client,
      prefix: `${rootPrefix}/revision`,
    });
    const key = { projectKey: "workspace", sessionId: "session-a" };
    await store.append(key, [
      { type: "user", uuid: "one" },
      { type: "assistant", uuid: "two" },
    ]);
    const revision = await store.captureRevision(key);
    expect(revision?.parts).toHaveLength(1);
    expect(revision?.sha256).toMatch(/^[a-f0-9]{64}$/);
    if (!revision) throw new Error("LocalStack revision was not captured");
    expect(await store.loadRevision(revision)).toEqual([
      { type: "user", uuid: "one" },
      { type: "assistant", uuid: "two" },
    ]);
  });

  test("isolates two sessions under the same workspace key", async () => {
    const store = new S3SessionStoreProbe({
      bucket: localstackBucket(),
      client,
      prefix: `${rootPrefix}/shared-workspace`,
    });
    const first = { projectKey: "workspace", sessionId: "first" };
    const second = { projectKey: "workspace", sessionId: "second" };
    await store.append(first, [{ type: "user", uuid: "first" }]);
    await store.append(second, [{ type: "user", uuid: "second" }]);

    expect(await store.load(first)).toEqual([{ type: "user", uuid: "first" }]);
    expect(await store.load(second)).toEqual([
      { type: "user", uuid: "second" },
    ]);
  });
});

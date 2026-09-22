import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { TranscriptEntry } from "@agent-platform/runtime-core";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";

import { ClaudeSessionStore } from "./session-store.ts";

const projectKey = "-workspace";
const sessionId = "session-1";
const root = { projectKey, sessionId };

function store(objects = createMemoryCheckpointObjectStore()) {
  return {
    objects,
    mirror: new ClaudeSessionStore({ objects, prefix: "sessions/s1/mirror" }),
  };
}

function entry(uuid: string, text: string): TranscriptEntry {
  return { type: "user", uuid, message: { content: text } };
}

describe("Claude session store", () => {
  test("round-trips root entries through separate append batches", async () => {
    const { mirror } = store();

    await mirror.append(root, [entry("a", "first")]);
    await mirror.append(root, [entry("b", "second")]);

    expect(await mirror.load(root)).toEqual([
      entry("a", "first"),
      entry("b", "second"),
    ]);
  });

  test("answers null for a session nothing has been mirrored for", async () => {
    const { mirror } = store();

    expect(await mirror.load(root)).toBeNull();
  });

  test("keeps subagent transcripts out of the root and lists their subpaths", async () => {
    const { mirror } = store();
    const subagent = { ...root, subpath: "agents/reviewer" };

    await mirror.append(root, [entry("a", "root")]);
    await mirror.append(subagent, [entry("b", "subagent")]);

    expect(await mirror.load(root)).toEqual([entry("a", "root")]);
    expect(await mirror.load(subagent)).toEqual([entry("b", "subagent")]);
    expect(await mirror.listSubkeys(root)).toEqual(["agents/reviewer"]);
  });

  test("restores a retried batch once", async () => {
    const { mirror } = store();

    await mirror.append(root, [entry("a", "first")]);
    // A timed-out append whose original write landed anyway.
    await mirror.append(root, [entry("a", "first")]);

    expect(await mirror.load(root)).toEqual([entry("a", "first")]);
  });

  test("restores a retried batch once even when key order differs", async () => {
    const { mirror } = store();

    await mirror.append(root, [{ type: "user", uuid: "a", left: 1, right: 2 }]);
    await mirror.append(root, [{ type: "user", uuid: "a", right: 2, left: 1 }]);

    expect(await mirror.load(root)).toHaveLength(1);
  });

  test("refuses a uuid that carries two different bodies", async () => {
    const { mirror } = store();

    await mirror.append(root, [entry("a", "first")]);
    await mirror.append(root, [entry("a", "tampered")]);

    await expect(mirror.load(root)).rejects.toThrow(
      /Conflicting transcript entry/,
    );
  });

  test("keeps entries that carry no uuid", async () => {
    const { mirror } = store();

    await mirror.append(root, [{ type: "title" }, { type: "title" }]);

    expect(await mirror.load(root)).toHaveLength(2);
  });

  test("a captured revision ignores everything mirrored after it", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);

    const revision = await mirror.captureRevision(root);
    await mirror.append(root, [entry("b", "later")]);

    if (revision === null) throw new Error("expected a revision");
    expect(revision.entryCount).toBe(1);
    expect(revision.parts).toHaveLength(1);
    expect(await mirror.loadRevision(revision)).toEqual([entry("a", "first")]);
    expect(await mirror.load(root)).toHaveLength(2);
  });

  test("captures null when the key holds nothing", async () => {
    const { mirror } = store();

    expect(await mirror.captureRevision(root)).toBeNull();
  });

  test("refuses a revision whose part list was edited", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");

    await expect(
      mirror.loadRevision({ ...revision, parts: [] }),
    ).rejects.toThrow(/digest mismatch/);
  });

  test("refuses a revision whose part bytes changed underneath it", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");
    const part = revision.parts[0];
    if (part === undefined) throw new Error("expected a part");
    await objects.put(part.key, new TextEncoder().encode('{"type":"x"}\n'));

    await expect(mirror.loadRevision(revision)).rejects.toThrow(
      /integrity failure/,
    );
  });

  test("refuses a revision that names a part the store no longer has", async () => {
    const { mirror } = store();
    const parts = [{ bytes: 1, key: "gone", sha256: "0".repeat(64) }];

    await expect(
      mirror.loadRevision({
        entryCount: 1,
        parts,
        sha256: createHash("sha256")
          .update(JSON.stringify(parts), "utf8")
          .digest("hex"),
      }),
    ).rejects.toThrow(/Missing transcript part/);
  });

  test("counts an append the object store rejected", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    objects.failWrites(1);

    await expect(mirror.append(root, [entry("a", "first")])).rejects.toThrow(
      /Injected object store failure/,
    );
    expect(mirror.appendFailures).toBe(1);
  });

  test("refuses a subpath that would escape the session namespace", async () => {
    const { mirror } = store();

    await expect(
      mirror.append({ ...root, subpath: "../other" }, [entry("a", "x")]),
    ).rejects.toThrow(/Unsafe transcript subpath/);
  });

  test("a replacement store appends after the stored tail", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = new ClaudeSessionStore({
      objects,
      prefix: "sessions/s1/mirror",
    });
    await first.append(root, [entry("a", "before restart")]);

    const resumed = new ClaudeSessionStore({
      objects,
      prefix: "sessions/s1/mirror",
    });
    await resumed.append(root, [entry("b", "after restart")]);

    expect(await resumed.load(root)).toEqual([
      entry("a", "before restart"),
      entry("b", "after restart"),
    ]);
  });

  test("two stores writing the same transcript replay in commit order", async () => {
    // The lease-handoff shape: two independent processes, no shared clock and
    // no shared sequence, appending to one transcript.
    for (let run = 0; run < 20; run += 1) {
      const objects = createMemoryCheckpointObjectStore();
      const options = { objects, prefix: "sessions/s1/mirror" };
      const stale = new ClaudeSessionStore(options);
      const live = new ClaudeSessionStore(options);

      await stale.append(root, [entry("a", "from the old worker")]);
      await live.append(root, [entry("b", "from the new worker")]);

      expect(await live.load(root)).toEqual([
        entry("a", "from the old worker"),
        entry("b", "from the new worker"),
      ]);
    }
  });

  test("two stores appending identical uuid-less batches keep both", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const options = { objects, prefix: "sessions/s1/mirror" };
    const left = new ClaudeSessionStore(options);
    const right = new ClaudeSessionStore(options);

    // Identical bytes, so the second write finds its slot already holding
    // exactly what it wanted to store. That is not the same as having stored
    // it, and nothing downstream could tell the difference afterwards.
    await Promise.all([
      left.append(root, [{ type: "title" }]),
      right.append(root, [{ type: "title" }]),
    ]);

    expect(await left.load(root)).toHaveLength(2);
  });

  test("two stores racing for the same slot do not lose a batch", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const options = { objects, prefix: "sessions/s1/mirror" };
    const left = new ClaudeSessionStore(options);
    const right = new ClaudeSessionStore(options);

    // Both start from an empty listing, so both want slot 0. The create-only
    // write decides, and the loser takes the next slot rather than vanishing.
    await Promise.all([
      left.append(root, [entry("a", "left")]),
      right.append(root, [entry("b", "right")]),
    ]);

    const restored = await left.load(root);
    expect(restored).toHaveLength(2);
    expect(new Set(restored?.map((item) => item.uuid))).toEqual(
      new Set(["a", "b"]),
    );
  });

  test("keeps root and subagent ordering independent", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = new ClaudeSessionStore({
      objects,
      prefix: "sessions/s1/mirror",
    });
    const subagent = { ...root, subpath: "agents/reviewer" };

    await mirror.append(root, [entry("r1", "root one")]);
    await mirror.append(subagent, [entry("s1", "sub one")]);
    await mirror.append(root, [entry("r2", "root two")]);
    await mirror.append(subagent, [entry("s2", "sub two")]);

    expect(await mirror.load(root)).toEqual([
      entry("r1", "root one"),
      entry("r2", "root two"),
    ]);
    expect(await mirror.load(subagent)).toEqual([
      entry("s1", "sub one"),
      entry("s2", "sub two"),
    ]);
  });

  test("a captured revision records each part's byte length", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);

    const revision = await mirror.captureRevision(root);
    const part = revision?.parts[0];
    if (part === undefined) throw new Error("expected a part");
    expect(part.bytes).toBeGreaterThan(0);
  });

  test("captures without re-reading parts it wrote itself", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    await mirror.append(root, [entry("b", "second")]);

    objects.resetReads();
    await mirror.captureRevision(root);
    await mirror.captureRevision(root);

    // Otherwise a session that checkpoints each turn re-downloads its whole
    // history every turn.
    expect(objects.reads()).toEqual([]);
  });

  test("a restore still confronts the bytes the store holds now", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");
    const part = revision.parts[0];
    if (part === undefined) throw new Error("expected a part");
    await objects.put(part.key, new TextEncoder().encode('{"type":"x"}\n'));

    // Same store instance, so a cached body would hide the corruption.
    await expect(mirror.loadRevision(revision)).rejects.toThrow(
      /integrity failure/,
    );
  });

  test("restores a revision whose entryCount the writer got wrong", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");

    // The digests already pin the exact bytes, so a miscounted manifest must
    // not be the thing that makes a session unresumable.
    expect(await mirror.loadRevision({ ...revision, entryCount: 99 })).toEqual([
      entry("a", "first"),
    ]);
  });

  test("replays concurrent appends in the order they were called", async () => {
    // Both calls race for the very first tick under the key, where nothing is
    // stored yet to order them by.
    for (let run = 0; run < 20; run += 1) {
      const { mirror } = store();

      await Promise.all([
        mirror.append(root, [entry(`a${run}`, "first")]),
        mirror.append(root, [entry(`b${run}`, "second")]),
      ]);

      expect(await mirror.load(root)).toEqual([
        entry(`a${run}`, "first"),
        entry(`b${run}`, "second"),
      ]);
    }
  });

  test("keeps subagent appends off the root's write queue", async () => {
    const { mirror } = store();
    const subagent = { ...root, subpath: "agents/reviewer" };

    await Promise.all([
      mirror.append(root, [entry("r1", "root one")]),
      mirror.append(subagent, [entry("s1", "sub one")]),
      mirror.append(root, [entry("r2", "root two")]),
    ]);

    expect(await mirror.load(root)).toEqual([
      entry("r1", "root one"),
      entry("r2", "root two"),
    ]);
    expect(await mirror.load(subagent)).toEqual([entry("s1", "sub one")]);
  });

  test("never lets two sessions share a key prefix", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);

    await mirror.append(root, [entry("a", "one")]);
    await mirror.append({ projectKey, sessionId: "session-2" }, [
      entry("b", "two"),
    ]);

    expect(await mirror.load(root)).toEqual([entry("a", "one")]);
    expect(
      objects.keys().every((key) => key.startsWith("sessions/s1/mirror/")),
    ).toBe(true);
  });
});

import { expect, test } from "bun:test";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export type ConformanceFactory = () => Promise<SessionStore> | SessionStore;

const key: SessionKey = { projectKey: "proj", sessionId: "sess" };
const entry = (
  type: string,
  extra: Record<string, unknown> = {},
): SessionStoreEntry => ({ type, ...extra });

export function runSessionStoreConformance(makeStore: ConformanceFactory) {
  test("append then load returns same entries in same order", async () => {
    const store = await makeStore();
    const entries = [
      entry("a", { n: 1, nested: { x: [1, 2] } }),
      entry("b", { n: 2 }),
    ];
    await store.append(key, entries);
    expect(await store.load(key)).toEqual(entries);
  });

  test("load unknown key returns null", async () => {
    const store = await makeStore();
    expect(await store.load(key)).toBeNull();
    expect(await store.load({ ...key, subpath: "subagents/a" })).toBeNull();
  });

  test("multiple append calls preserve call order", async () => {
    const store = await makeStore();
    await store.append(key, [entry("a")]);
    await store.append(key, [entry("b"), entry("c")]);
    await store.append(key, [entry("d")]);
    expect(await store.load(key)).toEqual([
      entry("a"),
      entry("b"),
      entry("c"),
      entry("d"),
    ]);
  });

  test("append empty batch is a no-op", async () => {
    const store = await makeStore();
    await store.append(key, []);
    expect(await store.load(key)).toBeNull();
    await store.append(key, [entry("a")]);
    await store.append(key, []);
    expect(await store.load(key)).toEqual([entry("a")]);
  });

  test("subpath keys are stored independently of main", async () => {
    const store = await makeStore();
    await store.append(key, [entry("main")]);
    await store.append({ ...key, subpath: "subagents/x" }, [entry("sub")]);
    expect(await store.load(key)).toEqual([entry("main")]);
    expect(await store.load({ ...key, subpath: "subagents/x" })).toEqual([
      entry("sub"),
    ]);
  });

  test("projectKey isolation", async () => {
    const store = await makeStore();
    const a = { projectKey: "A", sessionId: "s" };
    const b = { projectKey: "B", sessionId: "s" };
    await store.append(a, [entry("a")]);
    await store.append(b, [entry("b")]);
    expect(await store.load(a)).toEqual([entry("a")]);
    expect(await store.load(b)).toEqual([entry("b")]);
  });

  test("listSessions returns main session IDs for a project", async () => {
    const store = await makeStore();
    if (!store.listSessions) return;
    await store.append({ projectKey: "P", sessionId: "s1" }, [entry("a")]);
    await store.append({ projectKey: "P", sessionId: "s2" }, [entry("b")]);
    await store.append({ projectKey: "Q", sessionId: "s3" }, [entry("c")]);
    const sessions = await store.listSessions("P");
    expect(sessions.map(({ sessionId }) => sessionId).sort()).toEqual([
      "s1",
      "s2",
    ]);
    expect(sessions.every(({ mtime }) => mtime > 1e12)).toBe(true);
    expect(await store.listSessions("never-seen")).toEqual([]);
  });

  test("listSessions excludes subagent subpaths", async () => {
    const store = await makeStore();
    if (!store.listSessions) return;
    await store.append(
      { projectKey: "P", sessionId: "s1", subpath: "subagents/x" },
      [entry("sub")],
    );
    expect(await store.listSessions("P")).toEqual([]);
  });

  test("delete main then load returns null", async () => {
    const store = await makeStore();
    if (!store.delete) return;
    await store.append(key, [entry("a")]);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
  });

  test("delete main cascades to subkeys", async () => {
    const store = await makeStore();
    if (!store.delete) return;
    await store.append(key, [entry("main")]);
    await store.append({ ...key, subpath: "subagents/a" }, [entry("sub")]);
    await store.delete(key);
    expect(await store.load(key)).toBeNull();
    expect(await store.load({ ...key, subpath: "subagents/a" })).toBeNull();
  });

  test("delete with subpath removes only that subkey", async () => {
    const store = await makeStore();
    if (!store.delete) return;
    await store.append(key, [entry("main")]);
    await store.append({ ...key, subpath: "subagents/a" }, [entry("sub")]);
    await store.delete({ ...key, subpath: "subagents/a" });
    expect(await store.load(key)).toEqual([entry("main")]);
  });

  test("listSubkeys returns subpaths for the session", async () => {
    const store = await makeStore();
    if (!store.listSubkeys) return;
    await store.append({ ...key, subpath: "subagents/a" }, [entry("a")]);
    await store.append({ ...key, subpath: "subagents/b" }, [entry("b")]);
    expect(await store.listSubkeys(key)).toEqual([
      "subagents/a",
      "subagents/b",
    ]);
  });

  test("listSubkeys excludes the main transcript", async () => {
    const store = await makeStore();
    if (!store.listSubkeys) return;
    await store.append(key, [entry("main")]);
    expect(await store.listSubkeys(key)).toEqual([]);
  });
}

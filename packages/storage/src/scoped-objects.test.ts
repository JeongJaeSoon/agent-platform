import { describe, expect, test } from "bun:test";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit";

import {
  ObjectScopeError,
  scopedCheckpointObjectStore,
} from "./scoped-objects.ts";

const SCOPE = "sessions/s1/";
const encode = (text: string) => new TextEncoder().encode(text);

describe("scopedCheckpointObjectStore", () => {
  test("passes every operation through inside the scope", async () => {
    const inner = createMemoryCheckpointObjectStore();
    const store = scopedCheckpointObjectStore(inner, SCOPE);
    const key = `${SCOPE}checkpoints/0000000000/a1/manifest.json`;

    expect(await store.putImmutable(key, encode("{}"))).toEqual({
      outcome: "created",
    });
    await store.put(`${SCOPE}transcript/part-0`, encode("x"));
    expect(await store.get(key)).toEqual(encode("{}"));
    expect(await store.head(key)).toEqual({ bytes: 2 });
    expect(await store.list(`${SCOPE}checkpoints/`)).toEqual([key]);
    expect(await store.list(SCOPE)).toHaveLength(2);
  });

  test("refuses keys and list prefixes outside the scope before the store sees them", async () => {
    const inner = createMemoryCheckpointObjectStore();
    const store = scopedCheckpointObjectStore(inner, SCOPE);
    const foreign = "sessions/s2/checkpoints/0000000000/a1/manifest.json";

    await expect(store.get(foreign)).rejects.toBeInstanceOf(ObjectScopeError);
    await expect(store.head(foreign)).rejects.toThrow(ObjectScopeError);
    await expect(store.put(foreign, encode("x"))).rejects.toThrow(
      ObjectScopeError,
    );
    await expect(store.putImmutable(foreign, encode("x"))).rejects.toThrow(
      ObjectScopeError,
    );
    await expect(store.list("sessions/")).rejects.toThrow(ObjectScopeError);
    await expect(store.list("")).rejects.toThrow(ObjectScopeError);
    expect(inner.keys()).toEqual([]);
    expect(inner.reads()).toEqual([]);
  });

  test("a prefix that merely shares the scope's characters is outside it", async () => {
    const store = scopedCheckpointObjectStore(
      createMemoryCheckpointObjectStore(),
      "sessions/s1/",
    );
    await expect(store.get("sessions/s10/manifest.json")).rejects.toThrow(
      ObjectScopeError,
    );
    await expect(store.get("sessions/s1/")).rejects.toThrow(ObjectScopeError);
    for (const key of [
      "sessions/s1/../s2/x",
      "sessions/s1/./x",
      "sessions/s1//x",
      "sessions/s1/x/..",
      "sessions/s1/x/.",
    ]) {
      await expect(store.get(key)).rejects.toThrow(ObjectScopeError);
      await expect(store.list(`${key}/`)).rejects.toThrow(ObjectScopeError);
    }
  });

  test("the scope itself must be a plain key prefix ending in a slash", () => {
    const inner = createMemoryCheckpointObjectStore();
    expect(() => scopedCheckpointObjectStore(inner, "sessions/s1")).toThrow(
      'must end with "/"',
    );
    expect(() => scopedCheckpointObjectStore(inner, "/sessions/s1/")).toThrow(
      "plain key prefix",
    );
    expect(() => scopedCheckpointObjectStore(inner, "sessions/../")).toThrow(
      "plain key prefix",
    );
    expect(() => scopedCheckpointObjectStore(inner, "sessions//s1/")).toThrow(
      "plain key prefix",
    );
  });
});

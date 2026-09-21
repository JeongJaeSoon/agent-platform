import { describe, expect, test } from "bun:test";
import { isCatalogEmpty, parseSessionCatalogEnv } from "./catalog.ts";

describe("parseSessionCatalogEnv", () => {
  test("names the variable and the failing path", () => {
    const json = JSON.stringify({
      profiles: { p: { runtime_kind: "gpt", runtime_version: "1" } },
      repositories: {},
    });
    expect(() => parseSessionCatalogEnv("SESSION_CATALOG_JSON", json)).toThrow(
      /^SESSION_CATALOG_JSON is invalid: profiles\.p\.runtime_kind: /,
    );
  });

  test("names the variable on malformed JSON", () => {
    expect(() => parseSessionCatalogEnv("SESSION_CATALOG_JSON", "{")).toThrow(
      /^SESSION_CATALOG_JSON is invalid: /,
    );
  });

  test("defaults to an empty catalog when unset", () => {
    const catalog = parseSessionCatalogEnv("SESSION_CATALOG_JSON", undefined);
    expect(catalog).toEqual({ profiles: {}, repositories: {} });
    expect(isCatalogEmpty(catalog)).toBe(true);
  });

  test("a catalog missing only repositories still counts as empty", () => {
    expect(
      isCatalogEmpty({
        profiles: {
          p: { runtime_kind: "claude_agent_sdk", runtime_version: "1" },
        },
        repositories: {},
      }),
    ).toBe(true);
  });
});

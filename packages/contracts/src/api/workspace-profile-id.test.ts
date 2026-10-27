import { describe, expect, test } from "bun:test";
import { workspaceProfileId } from "./profiles.ts";

const ID = "911d7ab2-92ce-40d3-a09a-80ca4e41ad53";

describe("workspaceProfileId", () => {
  test("names a version after an id-safe slug", () => {
    expect(workspaceProfileId({ id: ID, slug: "acme-1" }, "strict", 3)).toBe(
      "ws_acme-1_strict_v3",
    );
  });

  test("falls back to the workspace id when the slug is not id-safe", () => {
    expect(workspaceProfileId({ id: ID, slug: "Acme_Co" }, "strict", 1)).toBe(
      `ws_${ID}_strict_v1`,
    );
  });
});

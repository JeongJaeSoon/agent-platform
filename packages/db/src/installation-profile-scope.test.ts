import { describe, expect, test } from "bun:test";
import { recordOf } from "./installation-profiles.ts";
import type { installationProfiles } from "./schema.ts";

const CREATED = new Date("2026-11-04T00:00:00.000Z");
const BLOCKED = new Date("2026-11-04T01:00:00.000Z");
const row = (repositoryScope: string, blockedAt: Date | null = null) =>
  ({
    repositoryScope,
    blockedAt,
    createdAt: CREATED,
  }) as typeof installationProfiles.$inferSelect;

describe("a stored repository_scope", () => {
  test.each(["profile", "workspace"])("%s reads as stored", (scope) => {
    expect(recordOf(row(scope))).toMatchObject({
      repository_scope: scope,
      blocked_at: null,
    });
  });

  test("one this image does not know blocks the profile, on neither ceiling", () => {
    expect(recordOf(row("later"))).toMatchObject({
      repository_scope: "profile",
      blocked_at: CREATED,
    });
    expect(recordOf(row("later", BLOCKED)).blocked_at).toBe(BLOCKED);
  });
});

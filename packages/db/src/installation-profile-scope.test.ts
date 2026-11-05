import { describe, expect, test } from "bun:test";
import { recordOf } from "./installation-profiles.ts";
import type { installationProfiles } from "./schema.ts";

const CREATED = new Date("2026-11-04T00:00:00.000Z");
const BLOCKED = new Date("2026-11-04T01:00:00.000Z");
const row = (repositoryScope: string | null, blockedAt: Date | null = null) =>
  ({
    repositoryScope,
    githubAppRepositories: null,
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

  test("none at all says nothing about repositories: it does not block, and the App list reads listed", () => {
    expect(recordOf(row(null))).toMatchObject({
      repository_scope: null,
      github_app_repositories: "listed",
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

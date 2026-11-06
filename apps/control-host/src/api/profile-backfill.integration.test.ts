import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { profileBackfill } from "./profile-backfill.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("profile-backfill", () => {
  let database: TempDatabase;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "profile_backfill_it" });
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 60_000);

  test("prints a dry run by default and the same counts when applied", async () => {
    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    const environment = { DATABASE_URL: database.url };
    expect(await profileBackfill([], environment, out)).toBe(0);
    expect(await profileBackfill(["--apply"], environment, out)).toBe(0);
    expect(await profileBackfill([], environment, out)).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        dry_run: true,
        pinned: { count: 0, agents: [] },
        model_follows_profile: { count: 0, agents: [] },
      },
      {
        dry_run: false,
        pinned: { count: 0, agents: [] },
        model_follows_profile: { count: 0, agents: [] },
      },
      {
        dry_run: true,
        pinned: { count: 0, agents: [] },
        model_follows_profile: { count: 0, agents: [] },
      },
    ]);
  });

  test("refuses an unknown option and a missing database", async () => {
    await expect(profileBackfill(["--force"], {}, () => {})).rejects.toThrow(
      "unknown option --force",
    );
    await expect(profileBackfill([], {}, () => {})).rejects.toThrow(
      "DATABASE_URL",
    );
  });
});

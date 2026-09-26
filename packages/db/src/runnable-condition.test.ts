import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HEARTBEAT_STATES, type RunnablePair } from "@agent-platform/platform";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import {
  ATTEMPT_PHASE_ORDER,
  runnableCondition,
  runnablePairOf,
} from "./worker-unit-of-work.ts";

// The claim picks candidates with runnableCondition in SQL and re-checks the
// locked row with runnablePairOf in JS; a row one accepts and the other
// refuses is either never claimed or claimed against the catalog.

const fingerprint = (c: string) => `sha256:${c.repeat(64)}`;
const RUNNABLE: RunnablePair[] = [
  {
    profileId: "profile-a",
    profileFingerprint: fingerprint("a"),
    repositoryId: "repo-a",
    url: "https://example.invalid/a.git",
    branch: "main",
  },
  {
    profileId: "profile-b",
    profileFingerprint: fingerprint("b"),
    repositoryId: "repo-a",
    url: "https://example.invalid/a.git",
    branch: "release",
  },
];

type Row = Pick<
  typeof sessions.$inferInsert,
  "profileId" | "profileFingerprint" | "repositoryId" | "repoUrl" | "branch"
>;

// Each pair as it is, then with one field changed at a time, crossed with
// every fingerprint a row can carry: none (before 94S-253), either pair's,
// and one the catalog never had.
function rows(): Row[] {
  const out: Row[] = [];
  for (const pair of RUNNABLE) {
    const base: Row = {
      profileId: pair.profileId,
      repositoryId: pair.repositoryId,
      repoUrl: pair.url,
      branch: pair.branch,
    };
    const variants: Row[] = [
      base,
      { ...base, profileId: "profile-z" },
      { ...base, profileId: null },
      { ...base, repositoryId: "repo-z" },
      { ...base, repositoryId: null },
      { ...base, repoUrl: "https://example.invalid/z.git" },
      { ...base, branch: "other" },
    ];
    for (const variant of variants) {
      for (const print of [null, fingerprint("a"), fingerprint("b"), "x"]) {
        out.push({ ...variant, profileFingerprint: print });
      }
    }
  }
  return out;
}

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  await db.insert(sessions).values(
    rows().map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      ownerId: "owner-a",
    })),
  );
});

afterAll(async () => {
  await client.close();
});

describe("runnable judgement", () => {
  for (const [name, runnable] of [
    ["both pairs", RUNNABLE],
    ["one pair", RUNNABLE.slice(1)],
    ["no pair", []],
  ] as const) {
    test(`SQL and JS pick the same sessions with ${name} runnable`, async () => {
      const all = await db.select().from(sessions);
      const inJs = all
        .filter((row) => runnablePairOf(row, runnable) !== undefined)
        .map((row) => row.id)
        .sort();
      const inSql = (
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(runnableCondition(runnable))
      )
        .map((row) => row.id)
        .sort();
      expect(inSql).toEqual(inJs);
      // Per pair: its own fingerprint and none match, the other two do not.
      expect(inJs).toHaveLength(runnable.length * 2);
    });
  }
});

test("a heartbeat can report exactly the phases the attempt state advances through, in that order", () => {
  const phases = Object.entries(ATTEMPT_PHASE_ORDER)
    .sort(([, left], [, right]) => left - right)
    .map(([state]) => state);
  expect(phases).toEqual([...HEARTBEAT_STATES]);
});

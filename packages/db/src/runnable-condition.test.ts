import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  HEARTBEAT_STATES,
  type RepositoryPair,
  type RunnablePair,
} from "@werft-ai/platform";
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
const RUNNABLE: RepositoryPair[] = [
  {
    profileId: "profile-a",
    profileFingerprint: fingerprint("a"),
    model: null,
    repositoryId: "repo-a",
    url: "https://example.invalid/a.git",
    branch: "main",
  },
  {
    profileId: "profile-b",
    profileFingerprint: fingerprint("b"),
    model: "model-b",
    repositoryId: "repo-a",
    url: "https://example.invalid/a.git",
    branch: "release",
  },
];

type Row = Pick<
  typeof sessions.$inferInsert,
  | "profileId"
  | "profileFingerprint"
  | "model"
  | "repositoryId"
  | "repoUrl"
  | "branch"
>;

// Each pair as it is, then with one field changed at a time, crossed with
// every fingerprint a row can carry: none (before), either pair's
// and one the catalog never had; and with every model: none (before the
// column), profile-b's and another.
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
        for (const model of [null, "model-b", "model-z"]) {
          out.push({ ...variant, profileFingerprint: print, model });
        }
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
  // profile-a: no fingerprint or its own, whatever the model (2 × 3);
  // profile-b: no fingerprint with any model (3), its own only with its
  // model (1).
  for (const [name, runnable, matched] of [
    ["both pairs", RUNNABLE, 10],
    ["one pair", RUNNABLE.slice(1), 4],
    ["no pair", [], 0],
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
      expect(inJs).toHaveLength(matched);
    });
  }

  test("a pair without a repository matches a row of mode none by profile, never a pre-catalog one", async () => {
    const none = [null, fingerprint("a"), fingerprint("b"), "x"].flatMap(
      (print) =>
        ["profile-a", "profile-z"].map((profileId) => ({
          id: crypto.randomUUID(),
          ownerId: "owner-a",
          profileId,
          profileFingerprint: print,
          repositoryMode: "none" as const,
          repositoryId: null,
          repoUrl: null,
          branch: null,
        })),
    );
    await db.insert(sessions).values(none);
    const without: RunnablePair = {
      profileId: "profile-a",
      profileFingerprint: fingerprint("a"),
      model: null,
      repositoryId: null,
    };
    const all = await db.select().from(sessions);
    const pick = (pairs: readonly RunnablePair[]) =>
      all
        .filter((row) => runnablePairOf(row, pairs) !== undefined)
        .map((row) => row.id)
        .sort();
    const inSql = async (pairs: readonly RunnablePair[]) =>
      (
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(runnableCondition(pairs))
      )
        .map((row) => row.id)
        .sort();
    const expected = none
      .filter(
        (row) =>
          row.profileId === "profile-a" &&
          (row.profileFingerprint === null ||
            row.profileFingerprint === fingerprint("a")),
      )
      .map((row) => row.id)
      .sort();
    expect(pick([without])).toEqual(expected);
    expect(await inSql([without])).toEqual(expected);
    const both = [...RUNNABLE, without];
    expect(pick(both)).toEqual([...pick(RUNNABLE), ...expected].sort());
    expect(await inSql(both)).toEqual(pick(both));
    expect(pick(RUNNABLE).some((id) => none.some((row) => row.id === id))).toBe(
      false,
    );
    await db.insert(sessions).values(
      [null, "model-b", "model-z"].map((model) => ({
        id: crypto.randomUUID(),
        ownerId: "owner-a",
        profileId: "profile-b",
        profileFingerprint: fingerprint("b"),
        model,
        repositoryMode: "none" as const,
        repositoryId: null,
        repoUrl: null,
        branch: null,
      })),
    );
    const v2: RunnablePair = {
      profileId: "profile-b",
      profileFingerprint: fingerprint("b"),
      model: "model-b",
      repositoryId: null,
    };
    const rows = await db.select().from(sessions);
    const inJs = rows
      .filter((row) => runnablePairOf(row, [v2]) !== undefined)
      .map((row) => row);
    expect(
      inJs
        .filter((row) => row.profileFingerprint !== null)
        .map((row) => row.model),
    ).toEqual(["model-b"]);
    expect(await inSql([v2])).toEqual(inJs.map((row) => row.id).sort());
  });
});

test("a heartbeat can report exactly the phases the attempt state advances through, in that order", () => {
  const phases = Object.entries(ATTEMPT_PHASE_ORDER)
    .sort(([, left], [, right]) => left - right)
    .map(([state]) => state);
  expect(phases).toEqual([...HEARTBEAT_STATES]);
});

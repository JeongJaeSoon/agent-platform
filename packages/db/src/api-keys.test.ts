import { afterEach, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createPostgresWorkspaceKeyStore } from "./api-keys.ts";
import * as schema from "./schema.ts";
import { apiKeys, memberships, users, workspaces } from "./schema.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let statements: string[];

beforeEach(async () => {
  client = new PGlite();
  statements = [];
  db = drizzle(client, {
    schema,
    logger: { logQuery: (query) => statements.push(query) },
  });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

afterEach(async () => {
  await client.close();
});

test("a list names every key's issuer in one statement, departed ones included", async () => {
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: "acme", name: "Acme" });
  const person = async (
    name: string,
    gone: { account?: boolean; membership?: boolean } = {},
  ) => {
    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      email: `${name.toLowerCase()}@example.invalid`,
      displayName: name,
      disabledAt: gone.account ? new Date() : null,
    });
    await db.insert(memberships).values({
      workspaceId,
      userId: id,
      role: "owner",
      disabledAt: gone.membership ? new Date() : null,
    });
    return id;
  };
  const owner = await person("Owner");
  const left = await person("Left", { membership: true });
  const disabled = await person("Disabled", { account: true });
  const issuers = [owner, left, disabled, null];
  for (const createdByUserId of issuers) {
    await db.insert(apiKeys).values({
      id: crypto.randomUUID(),
      keyHash: crypto.getRandomValues(new Uint8Array(32)),
      ownerId: workspaceId,
      workspaceId,
      scopes: ["sessions:read"],
      kind: "service",
      createdByUserId,
    });
  }

  statements = [];
  const listed = await createPostgresWorkspaceKeyStore(db).list(
    workspaceId,
    { personalOf: owner, allServiceKeysFor: ["owner"] },
    10,
  );

  expect(statements).toHaveLength(1);
  expect(
    listed.map((key) => [key.createdByUserId, key.createdByDisplayName]).sort(),
  ).toEqual(
    [
      [owner, "Owner"],
      [left, "Left"],
      [disabled, "Disabled"],
      [null, null],
    ].sort(),
  );
  expect(listed.every((key) => key.lastUsedAt === null)).toBe(true);
});

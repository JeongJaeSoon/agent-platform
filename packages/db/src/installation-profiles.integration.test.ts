import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type CatalogProfileConfig,
  catalogImports,
  catalogProfileConfigSchema,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, count, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findPgError } from "./control-shared.ts";
import { createPostgresInstallationProfileStore } from "./installation-profiles.ts";
import * as schema from "./schema.ts";
import { installationProfiles, users, workspaces } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

function definition(
  overrides: Partial<Record<string, unknown>> = {},
): CatalogProfileConfig {
  return catalogProfileConfigSchema.parse({
    runtime_kind: "claude_agent_sdk",
    runtime_version: "1",
    model: "claude-sonnet",
    models: ["claude-sonnet", "claude-haiku"],
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
    },
    ...overrides,
  });
}

integration("installation profiles on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "installation_profiles_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const ids = () => randomUUID().slice(0, 8);
  const rowsOf = (prefix: string) =>
    db
      .select()
      .from(installationProfiles)
      .orderBy(asc(installationProfiles.id))
      .then((rows) => rows.filter((row) => row.id.startsWith(prefix)));

  test("imports on an install with no owner or workspace yet", async () => {
    const [people] = await db.select({ n: count() }).from(users);
    const [spaces] = await db.select({ n: count() }).from(workspaces);
    expect([people?.n, spaces?.n]).toEqual([0, 0]);
    const prefix = `empty-${ids()}`;
    const result = await createPostgresInstallationProfileStore(
      db,
    ).importCatalog(catalogImports({ [`${prefix}-a`]: definition() }));
    expect(result).toEqual({ inserted: [`${prefix}-a`], conflicts: [] });
    const [row] = await rowsOf(prefix);
    expect(row).toMatchObject({
      origin: "catalog",
      name: null,
      version: 1,
      repositoryIds: [],
      createdBy: null,
      previousId: null,
      retiredAt: null,
      permissionMode: "default",
    });
  });

  test("importing the same catalog twice leaves the same rows", async () => {
    const prefix = `twice-${ids()}`;
    const catalog = {
      [`${prefix}-a`]: definition(),
      [`${prefix}-b`]: definition({ permission_mode: "auto", tools: [] }),
    };
    const store = createPostgresInstallationProfileStore(db);
    const first = await store.importCatalog(catalogImports(catalog));
    const afterFirst = await rowsOf(prefix);
    const second = await store.importCatalog(catalogImports(catalog));
    const afterSecond = await rowsOf(prefix);
    expect(first.inserted).toEqual([`${prefix}-a`, `${prefix}-b`]);
    expect(second).toEqual({ inserted: [], conflicts: [] });
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond).toEqual(afterFirst);
  });

  test("replicas starting together import each id once", async () => {
    const prefix = `race-${ids()}`;
    const catalog = Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [`${prefix}-${i}`, definition()]),
    );
    const replicas = Array.from({ length: 4 }, () => {
      const replicaPool = new Pool({ connectionString: database.url, max: 2 });
      return {
        pool: replicaPool,
        store: createPostgresInstallationProfileStore(
          drizzle(replicaPool, { schema }),
        ),
      };
    });
    try {
      const results = await Promise.all(
        replicas.map(({ store }) =>
          store.importCatalog(catalogImports(catalog)),
        ),
      );
      expect(results.flatMap((result) => result.inserted).sort()).toEqual(
        Object.keys(catalog).sort(),
      );
      expect(results.every((result) => result.conflicts.length === 0)).toBe(
        true,
      );
      expect(await rowsOf(prefix)).toHaveLength(6);
    } finally {
      await Promise.all(replicas.map(({ pool: p }) => p.end()));
    }
  });

  test("an id already there with another definition is reported, not overwritten", async () => {
    const prefix = `conflict-${ids()}`;
    const store = createPostgresInstallationProfileStore(db);
    await store.importCatalog(
      catalogImports({ [`${prefix}-a`]: definition() }),
    );
    const before = await rowsOf(prefix);
    const result = await store.importCatalog(
      catalogImports({
        [`${prefix}-a`]: definition({ models: ["claude-sonnet"], tools: [] }),
      }),
    );
    expect(result).toEqual({
      inserted: [],
      conflicts: [
        { id: `${prefix}-a`, origin: "catalog", fields: ["models", "tools"] },
      ],
    });
    expect(await rowsOf(prefix)).toEqual(before);
  });

  test("a YAML id a console row already holds is not imported", async () => {
    const id = `op_clash${ids()}_v1`;
    const made = definition();
    const [entry] = catalogImports({ [id]: made });
    if (!entry) throw new Error("no entry");
    await db.insert(installationProfiles).values({
      id,
      name: id.slice(3, -3),
      version: 1,
      origin: "console",
      definition: made,
      permissionMode: "default",
      fingerprint: entry.fingerprint,
      repositoryIds: ["sample-app"],
    });
    const result = await createPostgresInstallationProfileStore(
      db,
    ).importCatalog([entry]);
    expect(result).toEqual({
      inserted: [],
      conflicts: [{ id, origin: "console", fields: [] }],
    });
    const [row] = await db
      .select()
      .from(installationProfiles)
      .where(eq(installationProfiles.id, id));
    expect(row?.origin).toBe("console");
  });

  test("the table refuses rows outside the contract", async () => {
    const made = definition();
    const valid = {
      id: `bad-${ids()}`,
      name: null as string | null,
      version: 1,
      origin: "catalog",
      definition: made,
      permissionMode: "default",
      fingerprint: "sha256:x",
      repositoryIds: [],
    };
    const refused = async (
      values: Partial<typeof valid>,
      constraint: string,
    ) => {
      const error = await db
        .insert(installationProfiles)
        .values({ ...valid, id: `bad-${ids()}`, ...values })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(findPgError(error, "23514")?.constraint).toBe(constraint);
    };
    await refused({ id: "ws_acme_x_v1" }, "installation_profiles_id_check");
    await refused({ name: "named" }, "installation_profiles_name_check");
    await refused(
      { origin: "yaml", name: "named" },
      "installation_profiles_origin_check",
    );
    await refused({ version: 0 }, "installation_profiles_version_check");
    await refused(
      { permissionMode: "bypassPermissions" },
      "installation_profiles_definition_mode_check",
    );
    const console = {
      ...valid,
      origin: "console",
      name: `wide${ids()}`,
    };
    await db
      .insert(installationProfiles)
      .values({ ...console, id: `op_${console.name}_v1` });
    const duplicate = await db
      .insert(installationProfiles)
      .values({ ...console, id: `op_${console.name}_again` })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(findPgError(duplicate, "23505")?.constraint).toBe(
      "installation_profiles_console_version_key",
    );
  });
});

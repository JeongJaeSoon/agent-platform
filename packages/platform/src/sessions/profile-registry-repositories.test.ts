import { describe, expect, test } from "bun:test";
import type { CatalogRepositoryRow } from "../ports/catalog-repository-store.ts";
import {
  type CatalogProfile,
  type CatalogRepository,
  repositoryBinding,
} from "./catalog.ts";
import {
  createProfileRegistry,
  profileCatalog,
  type SnapshotSources,
  withConsoleRepositories,
} from "./profile-registry.ts";

const FILE: Record<string, CatalogRepository> = {
  // Credentialed: the operator's file keeps it.
  tool: {
    url: "https://github.com/acme/tool.git",
    branch: "main",
    auth: {
      kind: "basic",
      username: "x-access-token",
      password: { kind: "env", name: "TOOL_TOKEN" },
    } as never,
  },
  // `{ kind: github_app }` alone: the database's once it has been read.
  app: {
    url: "https://github.com/acme/app.git",
    branch: "main",
    profiles: ["coding"],
    auth: { kind: "github_app", registered: true },
  },
};

const rowOf = (
  fields: Partial<CatalogRepositoryRow> & Pick<CatalogRepositoryRow, "id">,
): CatalogRepositoryRow => ({
  github_repository_id: null,
  owner: "acme",
  name: fields.id,
  url: `https://github.com/acme/${fields.id}.git`,
  branch: "main",
  profiles: null,
  source: "console",
  version: 1,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
  ...fields,
});

const SOURCES: SnapshotSources<CatalogProfile> = {
  connections: {},
  allowUnattended: false,
  runtimeSupported: () => true,
  materialize: () => {
    throw new Error("no profile in this test");
  },
};

describe("console repositories in the catalog", () => {
  test("rows join the settings' entries; a credentialed settings id wins", () => {
    const merged = withConsoleRepositories(
      [
        rowOf({ id: "web", url: "https://github.com/acme/web.git" }),
        rowOf({ id: "tool", url: "https://github.com/evil/tool.git" }),
      ],
      FILE,
    );
    expect(Object.keys(merged).sort()).toEqual(["app", "tool", "web"]);
    expect(merged.tool).toBe(FILE.tool as CatalogRepository);
    expect(merged.web).toEqual({
      url: "https://github.com/acme/web.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    });
  });

  test("a seeded row binds exactly as its yaml entry did", () => {
    const [seeded] = Object.entries(
      withConsoleRepositories([
        rowOf({
          id: "app",
          source: "seed",
          profiles: ["coding"],
        }),
      ]),
    ).filter(([id]) => id === "app");
    if (seeded === undefined || FILE.app === undefined) {
      throw new Error("app missing");
    }
    expect(repositoryBinding("app", seeded[1])).toBe(
      repositoryBinding("app", FILE.app),
    );
  });

  test("the catalog follows the registry's reads and keeps its object while rows are equal", async () => {
    let rows: CatalogRepositoryRow[] = [rowOf({ id: "web" })];
    const registry = createProfileRegistry({
      workspaces: { listAll: async () => [] },
      installations: { listAll: async () => [] },
      repositories: {
        readCatalog: async () => rows.map((row) => ({ ...row })),
      },
      sources: SOURCES,
    });
    const catalog = profileCatalog({ repositories: FILE }, registry, (held) =>
      withConsoleRepositories(held, FILE),
    );
    expect(catalog.repositories).toBe(FILE);

    await registry.refresh();
    const first = catalog.repositories;
    expect(Object.keys(first).sort()).toEqual(["app", "tool", "web"]);
    // The gateway's claim cache keys on this object.
    expect(catalog.repositories).toBe(first);
    await registry.refresh();
    expect(catalog.repositories).toBe(first);

    rows = [rowOf({ id: "web", branch: "develop", version: 2 })];
    await registry.refresh();
    expect(catalog.repositories).not.toBe(first);
    expect(catalog.repositories.web?.branch).toBe("develop");

    rows = [];
    await registry.refresh();
    expect(Object.keys(catalog.repositories).sort()).toEqual(["app", "tool"]);
  });
});

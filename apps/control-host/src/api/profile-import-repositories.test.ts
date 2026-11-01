import { describe, expect, test } from "bun:test";
import type { CatalogRepository, SeedRepository } from "@werft-ai/platform";
import { seedCatalogRepositories } from "./profile-import.ts";

describe("seedCatalogRepositories", () => {
  test("seeds one row per GitHub repository and warns about the rest", async () => {
    const registered = { kind: "github_app", registered: true } as const;
    const file: Record<string, CatalogRepository> = {
      "app-main": {
        url: "https://github.com/acme/app.git",
        branch: "main",
        auth: registered,
      },
      "app-release": {
        url: "https://github.com/Acme/App.git",
        branch: "release",
        auth: registered,
      },
      plain: { url: "https://github.com/acme/plain.git", branch: "main" },
    };
    let seeded: SeedRepository[] = [];
    const warnings: unknown[] = [];
    await seedCatalogRepositories(
      {
        seed: async ({ entries }) => {
          seeded = await entries();
          return seeded.map((entry) => entry.id);
        },
      },
      file,
      { info: () => {}, warn: (_message, fields) => warnings.push(fields) },
    );
    expect(seeded.map((entry) => entry.id)).toEqual(["app-main"]);
    expect(warnings).toEqual([
      { repository: "app-release", seeded_as: "app-main" },
    ]);
  });
});

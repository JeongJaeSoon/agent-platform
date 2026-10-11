import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  GENERATED_SCHEMA,
  generateApiSchema,
} from "../../scripts/generate-api.ts";

test("schema.gen.ts is what `bun run --cwd apps/web api:generate` writes", async () => {
  expect(await readFile(GENERATED_SCHEMA, "utf8")).toBe(
    await generateApiSchema(),
  );
});

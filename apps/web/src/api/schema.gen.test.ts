import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  GENERATED_SCHEMA,
  generateApiSchema,
} from "../../scripts/generate-api.ts";

// The client's types are only as true as their source: docs/openapi.json is
// what the control host serves (openapi.test.ts keeps that one current).
test("schema.gen.ts is what `bun run --cwd apps/web api:generate` writes", async () => {
  expect(await readFile(GENERATED_SCHEMA, "utf8")).toBe(
    await generateApiSchema(),
  );
});

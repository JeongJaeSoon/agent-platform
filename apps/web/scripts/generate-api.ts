/**
 * src/api/schema.gen.ts from docs/openapi.json, the document the control host
 * publishes. `bun run api:generate` rewrites it; src/api/schema.gen.test.ts
 * fails when the committed file is not what this would write.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = join(import.meta.dir, "..", "..", "..");
export const OPENAPI_DOCUMENT = join(root, "docs", "openapi.json");
export const GENERATED_SCHEMA = join(
  import.meta.dir,
  "..",
  "src",
  "api",
  "schema.gen.ts",
);

const HEADER = `// Generated from docs/openapi.json by \`bun run --cwd apps/web api:generate\`.
// Do not edit by hand.

`;

export async function generateApiSchema(): Promise<string> {
  const ast = await openapiTS(pathToFileURL(OPENAPI_DOCUMENT));
  return HEADER + astToString(ast);
}

if (import.meta.main) {
  await Bun.write(GENERATED_SCHEMA, await generateApiSchema());
  console.log(`wrote ${GENERATED_SCHEMA}`);
}

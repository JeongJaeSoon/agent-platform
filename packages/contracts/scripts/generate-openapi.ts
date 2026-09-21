import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderOpenApiDocument } from "../src/openapi.ts";

export const OPENAPI_OUTPUT_PATH = join(
  import.meta.dir,
  "../../../docs/openapi.json",
);

if (import.meta.main) {
  writeFileSync(OPENAPI_OUTPUT_PATH, renderOpenApiDocument());
  console.log(`wrote ${OPENAPI_OUTPUT_PATH}`);
}

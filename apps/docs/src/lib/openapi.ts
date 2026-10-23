import { join } from "node:path";
import { createOpenAPI } from "fumadocs-openapi/server";

// The generated spec at the repo root is the only input; it is read, never
// copied. Next runs with apps/docs as the working directory, and the bundler
// rewrites import.meta.url, so the path is built from cwd.
const spec = join(process.cwd(), "../../docs/openapi.json");

export const openapi = createOpenAPI({
  // The id ends up in the document's URL, /openapi/werft.
  input: { werft: spec },
  // The spec is over 1 MB; inlined, every operation page carried a copy.
  includeDocument: false,
});

export function slugifyTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

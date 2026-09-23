import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A digest of the proxy's own source: every `.ts` under `dir` except tests.
 *
 * Compose runs the proxy from a bind-mounted checkout, and a Bun process
 * keeps the modules it loaded at start. Moving the checkout to a new commit
 * changes the files but not the running code (94S-319: qa-main served the
 * pre-#141 proxy for hours while its files already held the fix). The
 * process records this digest when it starts and the healthcheck compares
 * it with the files on disk, so a stale proxy reports itself unhealthy.
 */
export function sourceDigest(dir: string): string {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => path.split("\\").join("/"))
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.startsWith("testing/"),
    )
    .sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const bytes = readFileSync(join(dir, path));
    // Length-prefixed so moving bytes between a name and a file, or between
    // two files, cannot keep the digest.
    hash.update(`${path.length}:${path}${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

const HEALTH_SOURCE = /^ok source=([0-9a-f]{64})$/m;

/** The digest a running proxy reports on `/healthz`, if it reports one. */
export function reportedSourceDigest(body: string): string | null {
  return HEALTH_SOURCE.exec(body)?.[1] ?? null;
}

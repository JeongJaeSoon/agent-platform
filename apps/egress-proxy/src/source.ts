import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A digest of the proxy's own source: every `.ts` under `dir` except tests.
 *
 * A Bun process keeps the modules it loaded at start, so a source tree
 * mounted into the container and moved to a new commit changes the files but
 * not the running code (94S-319: compose then ran the proxy from a bind
 * mount, and qa-main served the pre-#141 proxy for hours while its files
 * already held the fix). The process records this digest when it starts and
 * the healthcheck compares it with the files on disk, so a stale proxy
 * reports itself unhealthy. The image compose runs now (94S-323) bakes the
 * source in; the digest still names the code that is running.
 */
export function sourceDigest(dir: string): string {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((path) => path.split("\\").join("/"))
    .filter(
      (path) =>
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.startsWith("testing/") &&
        // The recursive listing names directories too.
        statSync(join(dir, path)).isFile(),
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

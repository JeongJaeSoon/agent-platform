// drizzle-kit generate, then biome format on what it wrote under meta/.
//
// drizzle-kit lays out _journal.json and the snapshots its own way, which
// `bun run lint` rejects. Formatting here covers db:restack too, since it
// generates through this script. Arguments go to drizzle-kit generate.

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const packageDir = join(import.meta.dir, "..");

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: packageDir,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`db:generate: ${command} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("drizzle-kit", [
  "generate",
  "--config",
  "drizzle.config.ts",
  ...process.argv.slice(2),
]);
run("biome", ["format", "--write", "migrations/meta"]);

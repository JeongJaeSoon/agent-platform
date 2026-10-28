import {
  DEFAULT_CONFIG_DIR,
  loadCatalogConfig,
  readSeedProfiles,
} from "./catalog-config.ts";
import { connectionsFromProfiles } from "./profile-import.ts";

// The operator's profile migration command
// (docs/contributing/decisions/profile-db.md §1). Run where keys.ts runs:
// inside the API image, against its PLATFORM_CONFIG_DIR.
const USAGE =
  "Usage: bun run apps/control-host/src/api/profiles.ts connections-from-yaml";

export type ProfilesCommand = "connections-from-yaml";

export function parseProfilesCommand(argv: string[]): ProfilesCommand {
  if (argv.length === 1 && argv[0] === "connections-from-yaml") {
    return "connections-from-yaml";
  }
  throw new Error(USAGE);
}

async function main(): Promise<void> {
  parseProfilesCommand(Bun.argv.slice(2));
  const dir = Bun.env.PLATFORM_CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  const config = await loadCatalogConfig({ dir, env: Bun.env });
  process.stdout.write(
    connectionsFromProfiles(await readSeedProfiles(dir, config)),
  );
}

if (import.meta.main) {
  await main();
}

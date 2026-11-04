import { join } from "node:path";
import {
  parseSeedDocument,
  resolveSessionCatalog,
  type SessionCatalog,
} from "@werft-ai/platform";

/**
 * One of tests/fixtures/settings as the stack runs it: its ceilings over its
 * repositories, each `value_env` read from `env`. The fixture reads no other
 * kind of credential.
 */
export async function fixtureCatalog(
  name: string,
  env: Record<string, string | undefined>,
): Promise<SessionCatalog> {
  const seed = parseSeedDocument(
    await Bun.file(
      join(import.meta.dir, `../fixtures/settings/${name}.json`),
    ).json(),
  );
  if (seed.profiles === null) throw new Error(`${name} seeds no profile`);
  return resolveSessionCatalog(
    { profiles: seed.profiles, repositories: seed.entries.repositories },
    (ref) => ("value_env" in ref ? env[ref.value_env] : undefined),
  );
}

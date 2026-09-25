import { readFileSync } from "node:fs";
import { join } from "node:path";

// The compose files each installation merges (94S-430): the product services
// of compose.core.yml under the local layer (infra/docker-compose.yml) or
// the test-ops layer and its object store's (94S-432).

const root = join(import.meta.dir, "..");

export const CORE = "infra/compose.core.yml";
export const LOCAL_LAYERS = [CORE, "infra/compose.local.yml"] as const;
export const TEST_OPS_LAYERS = [CORE, "infra/compose.test-ops.yml"] as const;
/** Over the local stack, for `--real-model` (94S-431). */
export const REAL_MODEL = "infra/compose.real-model.yml";
export const TEST_OPS_STORE_LAYERS = {
  localstack: "infra/compose.test-ops.localstack.yml",
  s3: "infra/compose.test-ops.s3.yml",
} as const;

type Mapping = Record<string, unknown>;
const isMapping = (value: unknown): value is Mapping =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const servicesOf = (path: string) =>
  (
    Bun.YAML.parse(readFileSync(join(root, path), "utf8")) as {
      services?: Record<string, Mapping>;
    }
  ).services ?? {};

/**
 * The files' services, uninterpolated, merged as compose merges `-f` files
 * for what the tests read: mappings key by key, anything else replaced by
 * the later file. The layers use no `!reset` or `!override`; the render
 * tests hold this to `docker compose config`.
 */
export function layeredServices<Service>(
  paths: readonly string[],
): Record<string, Service> {
  const merged: Record<string, Mapping> = {};
  for (const path of paths) {
    for (const [name, service] of Object.entries(servicesOf(path))) {
      const into = merged[name] ?? {};
      merged[name] = into;
      for (const [key, value] of Object.entries(service)) {
        const prior = into[key];
        into[key] =
          isMapping(prior) && isMapping(value) ? { ...prior, ...value } : value;
      }
    }
  }
  return merged as Record<string, Service>;
}

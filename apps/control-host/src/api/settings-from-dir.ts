import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Connections,
  catalogConnectionsSchema,
  describeConfigError,
  type SessionCatalogConfig,
  sessionCatalogConfigSchema,
} from "@werft-ai/platform";
import { parse as parseYaml } from "yaml";
import { installedRuntimes } from "./catalog-config.ts";

export const PROFILES_FILE = "profiles.yaml";
export const REPOSITORIES_FILE = "repositories.yaml";
export const CONNECTIONS_FILE = "connections.yaml";
export const PLATFORM_FILE = "platform.yaml";
const MCP_SERVERS_FILE = "mcp-servers.yaml";

async function readYaml(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} is missing`);
  }
  try {
    // Not Bun.YAML: it keeps the last of two equal keys, so a profile
    // defined twice would silently lose its first, reviewed definition.
    return parseYaml(await file.text(), { uniqueKeys: true });
  } catch (error) {
    throw new Error(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function section(document: unknown, key: string, path: string): unknown {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    !Object.hasOwn(document, key)
  ) {
    throw new Error(`${path} must hold exactly one top-level key: ${key}`);
  }
  return (document as Record<string, unknown>)[key];
}

export async function readCatalogConfig(
  dir: string,
): Promise<SessionCatalogConfig> {
  const repositoriesPath = resolve(dir, REPOSITORIES_FILE);
  const mcpServersPath = resolve(dir, MCP_SERVERS_FILE);
  const parsed = sessionCatalogConfigSchema.safeParse({
    profiles: {},
    repositories: section(
      await readYaml(repositoriesPath),
      "repositories",
      repositoriesPath,
    ),
    ...((await Bun.file(mcpServersPath).exists())
      ? {
          mcp_servers: section(
            await readYaml(mcpServersPath),
            "mcp_servers",
            mcpServersPath,
          ),
        }
      : {}),
  });
  if (!parsed.success) {
    throw new Error(
      `Catalog config in ${dir} is invalid: ${describeConfigError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export async function readSeedProfiles(
  dir: string,
  config: SessionCatalogConfig,
): Promise<SessionCatalogConfig["profiles"]> {
  const path = resolve(dir, PROFILES_FILE);
  if (!(await Bun.file(path).exists())) return {};
  const parsed = sessionCatalogConfigSchema.safeParse({
    ...config,
    profiles: section(await readYaml(path), "profiles", path),
  });
  if (!parsed.success) {
    throw new Error(
      `Catalog config in ${dir} is invalid: ${describeConfigError(parsed.error)}`,
    );
  }
  installedRuntimes.assertProfiles(parsed.data.profiles);
  return parsed.data.profiles;
}

export async function readConnections(dir: string): Promise<Connections> {
  const path = resolve(dir, CONNECTIONS_FILE);
  const parsed = catalogConnectionsSchema.safeParse(
    section(await readYaml(path), "connections", path),
  );
  if (!parsed.success) {
    throw new Error(`${path} is invalid: ${describeConfigError(parsed.error)}`);
  }
  return parsed.data;
}

/** Kubernetes keeps its volume bookkeeping in dot entries. */
export async function dirIsEmpty(dir: string): Promise<boolean> {
  try {
    const names = await readdir(dir);
    return names.every((name) => name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

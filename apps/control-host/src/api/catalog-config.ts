import { resolve } from "node:path";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  OPT_IN_PERMISSION_MODES,
  UNATTENDED_PERMISSION_MODES,
} from "@werft-ai/contracts";
import {
  CatalogCredentialError,
  type CatalogProfile,
  type CatalogProfileConfig,
  type CatalogProfileView,
  type Connections,
  type CredentialRef,
  catalogConnectionsSchema,
  catalogCredentialRefs,
  catalogRepositoryIds,
  catalogRows,
  credentialRefOf,
  describeConfigError,
  installationProfileSnapshot,
  ProfileFeatureGate,
  resolveCredential,
  resolveSessionCatalog,
  SecretKey,
  type SessionCatalog,
  type SessionCatalogConfig,
  type SnapshotSources,
  sessionCatalogConfigSchema,
  sessionCatalogView,
} from "@werft-ai/platform";
import { installedDescriptors } from "@werft-ai/runtime-codecs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// The installation's files: connections.yaml and repositories.yaml (and
// mcp-servers.yaml with remote MCP servers) in one directory, read once at
// startup. Anything wrong — a missing file, a schema error, a credential
// that does not resolve — stops the API with a message naming the file and
// path, never a value. profiles.yaml is read only to seed an empty
// database (readSeedProfiles).

/** The repository's own `config/`, wherever the process was started from. */
export const DEFAULT_CONFIG_DIR = resolve(
  import.meta.dir,
  "../../../../config",
);
export const PROFILES_FILE = "profiles.yaml";
export const REPOSITORIES_FILE = "repositories.yaml";
export const CONNECTIONS_FILE = "connections.yaml";
const MCP_SERVERS_FILE = "mcp-servers.yaml";
export const ALLOW_UNATTENDED_SETTING = "PLATFORM_ALLOW_UNATTENDED_PERMISSIONS";
export const PLATFORM_FILE = "platform.yaml";
export const SECRET_KEY_SETTING = "PLATFORM_SECRET_KEY";
// One bounded read per secret at startup; the API does not start without
// them, so a hung endpoint must fail the boot rather than hold it.
const SECRET_READ_TIMEOUT_MS = 10_000;

/** The runtimes the worker image ships, as the control plane sees them. */
export const installedRuntimes = new ProfileFeatureGate(installedDescriptors);

export type SecretReader = (secretId: string) => Promise<string | undefined>;

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

/** The directory's repositories and MCP servers; `profiles` is always empty. */
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

/**
 * profiles.yaml under the catalog's rules, or none without the file: what
 * an empty installation_profiles table is seeded with.
 */
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

export function secretsManagerReader(
  env: Record<string, string | undefined>,
  timeoutMs = SECRET_READ_TIMEOUT_MS,
): SecretReader {
  let client: SecretsManagerClient | undefined;
  return async (secretId) => {
    // Built on first use: a catalog with only environment references never
    // needs a region or an endpoint.
    client ??= new SecretsManagerClient({
      ...(env.AWS_REGION === undefined ? {} : { region: env.AWS_REGION }),
      // Its own endpoint, never AWS_ENDPOINT_URL: locally that one is the
      // object store workers can reach, and secrets must not be.
      // The SDK would fall back to it on its own, so configured endpoints
      // are ignored and only this variable (or AWS itself) is used.
      ignoreConfiguredEndpointUrls: true,
      ...(env.AWS_ENDPOINT_URL_SECRETS_MANAGER === undefined
        ? {}
        : { endpoint: env.AWS_ENDPOINT_URL_SECRETS_MANAGER }),
      maxAttempts: 2,
    });
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
      { abortSignal: AbortSignal.timeout(timeoutMs) },
    );
    return result.SecretString;
  };
}

/**
 * The catalog's files under every rule but its credentials, which only
 * loadSessionCatalog resolves.
 */
export async function loadCatalogConfig(options: {
  dir: string;
  env: Record<string, string | undefined>;
}): Promise<SessionCatalogConfig> {
  if (options.env.SESSION_CATALOG_JSON !== undefined) {
    // Two sources would let one quietly win; the old one is gone.
    throw new Error(
      `SESSION_CATALOG_JSON is no longer read: move the catalog to ${CONNECTIONS_FILE}, ${REPOSITORIES_FILE} and the ${PROFILES_FILE} seed (PLATFORM_CONFIG_DIR) and unset it`,
    );
  }
  return readCatalogConfig(options.dir);
}

/** `connections.yaml`: the only providers any ceiling runs against. */
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

/**
 * Whether this process may run a profile nothing judges. A catalog is
 * copied between installations and cannot vouch for the one it lands in.
 */
export function unattendedAllowed(
  env: Record<string, string | undefined>,
): boolean {
  return env[ALLOW_UNATTENDED_SETTING] === "true";
}

/** What a replica holding no provider key builds its profile snapshot from. */
export function profileViewSources(
  connections: Connections,
  repositories: SessionCatalogConfig["repositories"],
  env: Record<string, string | undefined>,
): SnapshotSources<CatalogProfileView> {
  return {
    connections,
    repositoryIdsOf: catalogRepositoryIds(repositories),
    allowUnattended: unattendedAllowed(env),
    runtimeSupported: runtimeServes,
    materialize: (id, definition) => {
      const view = sessionCatalogView({
        profiles: { [id]: definition },
        repositories: {},
      }).profiles[id];
      if (!view) throw new Error(`profile ${id} has no view`);
      return view;
    },
  };
}

export function runtimeServes(profile: CatalogProfileConfig): boolean {
  try {
    installedRuntimes.assertProfiles({ profile });
    return true;
  } catch {
    return false;
  }
}

/**
 * The catalog with every credential resolved, and what its profile snapshot
 * is built from: a provider credential is resolved from the connections
 * alone, so a database row can bring in no reference of its own.
 */
export async function loadProfileSources(options: {
  dir: string;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
}): Promise<{
  config: SessionCatalogConfig;
  connections: Connections;
  catalog: SessionCatalog;
  sources: SnapshotSources<CatalogProfile>;
}> {
  const connections = await readConnections(options.dir);
  const config = await loadCatalogConfig(options);
  const secrets = new Map<string, string>();
  // An endpoint that is not up, like the local stack's secrets service
  // without --fake-model, fails on DNS or a refused connection; naming it says which.
  const endpoint = options.env.AWS_ENDPOINT_URL_SECRETS_MANAGER;
  const from = endpoint === undefined ? "" : ` from ${endpoint}`;
  for (const { path, ref } of catalogCredentialRefs(config, connections)) {
    if (!("secret_id" in ref) || secrets.has(ref.secret_id)) continue;
    let value: string | undefined;
    try {
      value = await options.readSecret(ref.secret_id);
    } catch (error) {
      throw new CatalogCredentialError(
        path,
        ref,
        `could not be read${from} (${error instanceof Error ? error.name : "error"})`,
      );
    }
    if (value) secrets.set(ref.secret_id, value);
  }
  const lookup = (ref: CredentialRef) =>
    "value_env" in ref
      ? options.env[ref.value_env]
      : secrets.get(ref.secret_id);
  // Every connection's credential resolves before the API starts, as every
  // profile's did when profiles carried them.
  for (const { path, ref } of catalogCredentialRefs(
    { profiles: {}, repositories: {} },
    connections,
  )) {
    resolveCredential(path, ref, lookup);
  }
  const resolved = resolveSessionCatalog({ ...config, profiles: {} }, lookup);
  const sources: SnapshotSources<CatalogProfile> = {
    connections,
    repositoryIdsOf: catalogRepositoryIds(config.repositories),
    allowUnattended: unattendedAllowed(options.env),
    runtimeSupported: runtimeServes,
    materialize: (id, definition) => {
      const profile = resolveSessionCatalog(
        { profiles: { [id]: definition }, repositories: {} },
        lookup,
      ).profiles[id];
      if (!profile) throw new Error(`profile ${id} did not resolve`);
      return profile;
    },
  };
  return { config, connections, catalog: resolved, sources };
}

/**
 * The catalog this directory runs once its `profiles.yaml` seeds an empty
 * database, credentials resolved: what a fresh installation's registry
 * first reads.
 */
export async function loadSessionCatalog(options: {
  dir: string;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
}): Promise<SessionCatalog> {
  const loaded = await loadProfileSources(options);
  const { profiles, installation } = installationProfileSnapshot(
    loaded.sources,
    catalogRows(
      await readSeedProfiles(options.dir, loaded.config),
      loaded.config.repositories,
    ),
  );
  return { ...loaded.catalog, profiles, installation };
}

const platformConfigSchema = z
  .object({
    secret_key: z
      .object({
        value_env: z.string().min(1).optional(),
        secret_id: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (ref) =>
          (ref.value_env === undefined) !== (ref.secret_id === undefined),
        { message: "name exactly one of value_env or secret_id" },
      ),
  })
  .strict();

/**
 * The master key runtime secrets are encrypted under, or null when the
 * store is off. With `platform.yaml` in the catalog its `secret_key`
 * reference must resolve; without it, PLATFORM_SECRET_KEY is read if set.
 * Either way a value that is not 64 hex characters stops the API, and no
 * message carries the value.
 */
export async function loadSecretKey(options: {
  dir: string;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
}): Promise<SecretKey | null> {
  const path = resolve(options.dir, PLATFORM_FILE);
  if (!(await Bun.file(path).exists())) {
    const value = options.env[SECRET_KEY_SETTING];
    // Compose passes an unset variable through as empty.
    if (value === undefined || value === "") return null;
    return SecretKey.fromHex(value, SECRET_KEY_SETTING);
  }
  const parsed = platformConfigSchema.safeParse(
    section(await readYaml(path), "platform", path),
  );
  if (!parsed.success) {
    throw new Error(`${path} is invalid: ${describeConfigError(parsed.error)}`);
  }
  const at = "platform.secret_key";
  const ref = credentialRefOf(parsed.data.secret_key);
  let value: string | undefined;
  if ("value_env" in ref) {
    value = options.env[ref.value_env];
  } else {
    try {
      value = await options.readSecret(ref.secret_id);
    } catch (error) {
      throw new CatalogCredentialError(
        at,
        ref,
        `could not be read (${error instanceof Error ? error.name : "error"})`,
      );
    }
  }
  if (!value) throw new CatalogCredentialError(at, ref);
  return SecretKey.fromHex(
    value,
    `${at} (${"value_env" in ref ? ref.value_env : ref.secret_id})`,
  );
}

const profilesIn =
  (modes: readonly string[]) =>
  (catalog: {
    profiles: Record<string, { permission_mode: string }>;
  }): string[] =>
    Object.entries(catalog.profiles)
      .filter(([, profile]) => modes.includes(profile.permission_mode))
      .map(([id]) => id);

/** Profiles whose tools run without a person answering; logged at startup. */
export const unattendedProfiles = profilesIn(UNATTENDED_PERMISSION_MODES);

/**
 * Profiles whose tool calls nothing judges. That leaves the container, the
 * egress allowlist, the tool list and the cost limit as the only bounds, so
 * the installation has to opt in: a catalog is copied between installations
 * and cannot vouch for the one it lands in. `auto` is not among them: its
 * classifier still refuses a call.
 */
export const optInProfiles = profilesIn(OPT_IN_PERMISSION_MODES);

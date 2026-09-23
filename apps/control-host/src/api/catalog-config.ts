import { resolve } from "node:path";
import {
  CatalogCredentialError,
  type CredentialRef,
  credentialRefOf,
  describeConfigError,
  resolveSessionCatalog,
  type SessionCatalog,
  type SessionCatalogConfig,
  sessionCatalogConfigSchema,
} from "@agent-platform/platform";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { parse as parseYaml } from "yaml";

// The operator's catalog (94S-132): two YAML files in one directory, read
// once at startup. Anything wrong — a missing file, a schema error, a
// credential that does not resolve — stops the API with a message naming
// the file and path, never a value.

/** The repository's own `config/`, wherever the process was started from. */
export const DEFAULT_CONFIG_DIR = resolve(
  import.meta.dir,
  "../../../../config",
);
export const PROFILES_FILE = "profiles.yaml";
export const REPOSITORIES_FILE = "repositories.yaml";
// One bounded read per secret at startup; the API does not start without
// them, so a hung endpoint must fail the boot rather than hold it.
export const SECRET_READ_TIMEOUT_MS = 10_000;

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

export async function readCatalogConfig(
  dir: string,
): Promise<SessionCatalogConfig> {
  const profilesPath = resolve(dir, PROFILES_FILE);
  const repositoriesPath = resolve(dir, REPOSITORIES_FILE);
  const parsed = sessionCatalogConfigSchema.safeParse({
    profiles: section(await readYaml(profilesPath), "profiles", profilesPath),
    repositories: section(
      await readYaml(repositoriesPath),
      "repositories",
      repositoriesPath,
    ),
  });
  if (!parsed.success) {
    throw new Error(
      `Catalog config in ${dir} is invalid: ${describeConfigError(parsed.error)}`,
    );
  }
  return parsed.data;
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
      // object store workers can reach, and secrets must not be (94S-132).
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

export async function loadSessionCatalog(options: {
  dir: string;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
}): Promise<SessionCatalog> {
  if (options.env.SESSION_CATALOG_JSON !== undefined) {
    // Two sources would let one quietly win; the old one is gone.
    throw new Error(
      `SESSION_CATALOG_JSON is no longer read: move the catalog to ${PROFILES_FILE} and ${REPOSITORIES_FILE} (PLATFORM_CONFIG_DIR) and unset it`,
    );
  }
  const config = await readCatalogConfig(options.dir);
  const secrets = new Map<string, string>();
  for (const [id, profile] of Object.entries(config.profiles)) {
    const { kind: _kind, ...fields } = profile.provider.auth;
    const ref = credentialRefOf(fields);
    if (!("secret_id" in ref) || secrets.has(ref.secret_id)) continue;
    let value: string | undefined;
    try {
      value = await options.readSecret(ref.secret_id);
    } catch (error) {
      throw new CatalogCredentialError(
        id,
        ref,
        `could not be read (${error instanceof Error ? error.name : "error"})`,
      );
    }
    if (value) secrets.set(ref.secret_id, value);
  }
  return resolveSessionCatalog(config, (ref: CredentialRef) =>
    "value_env" in ref
      ? options.env[ref.value_env]
      : secrets.get(ref.secret_id),
  );
}

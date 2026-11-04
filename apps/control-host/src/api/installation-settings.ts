import {
  type CatalogProfileConfig,
  type CredentialRef,
  type InstallationSettingsStore,
  isRegisteredGitHubApp,
  type SessionCatalogConfig,
  type SettingsImport,
  type SettingsSnapshot,
  settingsCredentialRefs,
  settingsSnapshot,
  withStoredValues,
} from "@werft-ai/platform";
import type { SecretReader } from "./catalog-config.ts";

/**
 * Where the registry reads the installation's settings from, credentials
 * resolved: an env reference from `env`, a Secrets Manager one once per
 * process (rotating it still means a restart, as with the files), a stored
 * one from the database on every read.
 */
export function settingsSource(options: {
  store: Pick<InstallationSettingsStore, "read">;
  env: Record<string, string | undefined>;
  readSecret: SecretReader;
}): { read(): Promise<SettingsSnapshot> } {
  const fetched = new Map<string, string>();
  return {
    async read() {
      const settings = await options.store.read();
      for (const ref of settingsCredentialRefs(settings)) {
        if (!("secret_id" in ref) || fetched.has(ref.secret_id)) continue;
        try {
          const value = await options.readSecret(ref.secret_id);
          if (value) fetched.set(ref.secret_id, value);
        } catch {
          // Left out of this read, named in left_out, and tried again next.
        }
      }
      return settingsSnapshot(
        settings,
        withStoredValues(settings, (ref: CredentialRef) =>
          "value_env" in ref
            ? options.env[ref.value_env]
            : "secret_id" in ref
              ? fetched.get(ref.secret_id)
              : undefined,
        ),
      );
    },
  };
}

/**
 * The settings with `credential` standing in for every value: for a process
 * that holds none and only checks what a release or claim would name.
 */
export function settingsViewSource(
  store: Pick<InstallationSettingsStore, "read">,
  credential: () => string,
): { read(): Promise<SettingsSnapshot> } {
  return {
    async read() {
      return settingsSnapshot(await store.read(), credential);
    },
  };
}

/**
 * The operator files' connections, credential-holding repositories and MCP
 * servers, for the import that moves them into the database. Repositories
 * on the console's GitHub App have their own seed.
 */
export function fileSettings(
  config: SessionCatalogConfig,
  connections: Readonly<Record<string, CatalogProfileConfig["provider"]>>,
): SettingsImport {
  return {
    connections,
    repositories: Object.fromEntries(
      Object.entries(config.repositories).filter(
        ([, repository]) =>
          repository.auth === undefined ||
          !isRegisteredGitHubApp(repository.auth),
      ),
    ),
    mcpServers: config.mcp_servers ?? {},
  };
}

/** One warning line per change in what the settings leave out. */
export function leftOutReporter(
  warn: (message: string, fields: Record<string, unknown>) => void,
): (snapshot: SettingsSnapshot) => void {
  let last = "[]";
  return (snapshot) => {
    const now = JSON.stringify(snapshot.left_out);
    if (now === last) return;
    last = now;
    if (snapshot.left_out.length > 0) {
      warn("Installation settings left out of this replica's catalog", {
        left_out: snapshot.left_out,
      });
    }
  };
}

import type { InstallationSettings } from "../ports/installation-settings-store.ts";
import {
  type CatalogMcpServer,
  type CatalogRepository,
  type CredentialRef,
  catalogCredentialRefs,
  credentialRefOf,
  describeConfigError,
  resolveCredential,
  resolveSessionCatalog,
} from "./catalog.ts";
import type { Connections } from "./profile-registry.ts";

/** What the registry runs from one read of the installation's settings. */
export type SettingsSnapshot = {
  generation: number;
  /** The connections whose credential resolves. */
  connections: Connections;
  repositories: Record<string, CatalogRepository>;
  mcp_servers: Record<string, CatalogMcpServer>;
  /** What a ceiling's provider credential resolves through. */
  lookup: (ref: CredentialRef) => string | undefined;
  /** Rows this read leaves out, each with why; never a value. */
  left_out: Array<{ entry: string; reason: string }>;
};

/** Every reference the settings name, for fetching before they resolve. */
export function settingsCredentialRefs(
  settings: InstallationSettings,
): CredentialRef[] {
  return catalogCredentialRefs(
    {
      profiles: {},
      repositories: Object.fromEntries(
        settings.repositories.map(({ id, repository }) => [id, repository]),
      ),
      mcp_servers: Object.fromEntries(
        settings.mcpServers.map(({ id, server }) => [id, server]),
      ),
    },
    Object.fromEntries(
      settings.connections.map(({ id, provider }) => [id, provider]),
    ),
  ).map(({ ref }) => ref);
}

/**
 * The stored values the read brought, then `external` (an env or Secrets
 * Manager reference, already fetched) for the rest.
 */
export function withStoredValues(
  settings: Pick<InstallationSettings, "stored">,
  external: (ref: CredentialRef) => string | undefined,
): (ref: CredentialRef) => string | undefined {
  return (ref) =>
    "stored" in ref ? settings.stored.get(ref.stored) : external(ref);
}

/**
 * The settings with each credential resolved through `lookup`. A row whose
 * credential does not resolve is left out on its own, so one missing value
 * never stops the rest; every replica reads the same rows and values, so
 * they leave out the same ones.
 */
export function settingsSnapshot(
  settings: InstallationSettings,
  lookup: (ref: CredentialRef) => string | undefined,
): SettingsSnapshot {
  const left_out = settings.invalid.map((entry) => ({
    entry,
    reason: "does not parse",
  }));
  const connections: Record<string, Connections[string]> = {};
  for (const { id, provider } of settings.connections) {
    const { kind: _kind, ...fields } = provider.auth;
    try {
      resolveCredential(
        `connections.${id}.auth`,
        credentialRefOf(fields),
        lookup,
      );
      connections[id] = provider;
    } catch (error) {
      left_out.push({
        entry: `connection:${id}`,
        reason: describeConfigError(error),
      });
    }
  }
  const repositories: Record<string, CatalogRepository> = {};
  for (const { id, repository } of settings.repositories) {
    try {
      const resolved = resolveSessionCatalog(
        { profiles: {}, repositories: { [id]: repository } },
        lookup,
      ).repositories[id];
      if (resolved) repositories[id] = resolved;
    } catch (error) {
      left_out.push({
        entry: `repository:${id}`,
        reason: describeConfigError(error),
      });
    }
  }
  const mcp_servers: Record<string, CatalogMcpServer> = {};
  for (const { id, server } of settings.mcpServers) {
    try {
      const resolved = resolveSessionCatalog(
        { profiles: {}, repositories: {}, mcp_servers: { [id]: server } },
        lookup,
      ).mcp_servers?.[id];
      if (resolved) mcp_servers[id] = resolved;
    } catch (error) {
      left_out.push({ entry: `mcp:${id}`, reason: describeConfigError(error) });
    }
  }
  return {
    generation: settings.generation,
    connections,
    repositories,
    mcp_servers,
    lookup,
    left_out,
  };
}

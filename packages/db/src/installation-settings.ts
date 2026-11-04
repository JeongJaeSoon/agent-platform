import { canonicalJson } from "@werft-ai/contracts";
import {
  type CatalogMcpServerConfig,
  type CatalogProfileConfig,
  type CatalogRepositoryConfig,
  catalogMcpServerSchema,
  catalogProviderSchema,
  catalogRepositorySchema,
  type InstallationSettingsStore,
  isRegisteredGitHubApp,
  repoRefOf,
  type SecretKey,
} from "@werft-ai/platform";
import { asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  type CatalogRepositoryAuthKind,
  catalogRepositories,
  mcpServers,
  providerConnections,
  type SettingsCredentialSource,
  settingsGeneration,
  workspaces,
} from "./schema.ts";
import { openSecretsOfPurpose, writeSecretInTx } from "./secret-values.ts";

const PURPOSE = "settings_credential";

type RepositoryRow = typeof catalogRepositories.$inferSelect;
type McpRow = typeof mcpServers.$inferSelect;

const sourceOf = (auth: { stored?: string | undefined }) =>
  (auth.stored === undefined ? "external" : "stored") as SettingsCredentialSource;

// The entry repositories.yaml would give for the row, so its binding hash
// is the one sessions claimed under before the move.
function repositoryConfigOf(row: RepositoryRow): unknown {
  return {
    url: row.url,
    branch: row.branch,
    ...(row.profiles === null ? {} : { profiles: row.profiles }),
    ...(row.authKind === "github_app"
      ? { auth: { kind: "github_app" } }
      : row.auth === null
        ? {}
        : { auth: row.auth }),
  };
}

function mcpConfigOf(row: McpRow): unknown {
  return {
    url: row.url,
    credential_ref: row.credentialRef,
    auth: row.auth,
    workspaces: row.workspaces,
  };
}

function authKindOf(
  auth: CatalogRepositoryConfig["auth"],
): CatalogRepositoryAuthKind {
  if (auth === undefined) return "none";
  if (auth.kind === "github_app") return "github_app_explicit";
  return auth.kind;
}

async function generationIn(tx: Database): Promise<number> {
  const [row] = await tx
    .select({ generation: settingsGeneration.generation })
    .from(settingsGeneration)
    .where(eq(settingsGeneration.id, 1));
  return row?.generation ?? 0;
}

export function createPostgresInstallationSettingsStore(
  db: Database,
  /** Null when the secret store is off: no stored value can be read or set. */
  key: SecretKey | null,
): InstallationSettingsStore {
  return {
    read() {
      return db.transaction(
        async (tx) => {
          const generation = await generationIn(tx);
          const invalid: string[] = [];
          const connections: Array<{
            id: string;
            provider: CatalogProfileConfig["provider"];
          }> = [];
          for (const row of await tx
            .select()
            .from(providerConnections)
            .where(isNull(providerConnections.disabledAt))
            .orderBy(asc(providerConnections.id))) {
            const parsed = catalogProviderSchema.safeParse(row.definition);
            if (parsed.success) {
              connections.push({ id: row.id, provider: parsed.data });
            } else invalid.push(`connection:${row.id}`);
          }
          const repositories: Array<{
            id: string;
            repository: CatalogRepositoryConfig;
          }> = [];
          for (const row of await tx
            .select()
            .from(catalogRepositories)
            .where(isNull(catalogRepositories.removedAt))
            .orderBy(asc(catalogRepositories.id))) {
            const parsed = catalogRepositorySchema.safeParse(
              repositoryConfigOf(row),
            );
            if (parsed.success) {
              repositories.push({ id: row.id, repository: parsed.data });
            } else invalid.push(`repository:${row.id}`);
          }
          const servers: Array<{ id: string; server: CatalogMcpServerConfig }> =
            [];
          for (const row of await tx
            .select()
            .from(mcpServers)
            .where(isNull(mcpServers.disabledAt))
            .orderBy(asc(mcpServers.id))) {
            const parsed = catalogMcpServerSchema.safeParse(mcpConfigOf(row));
            if (parsed.success) {
              servers.push({ id: row.id, server: parsed.data });
            } else invalid.push(`mcp:${row.id}`);
          }
          const stored =
            key === null
              ? new Map<string, string>()
              : await openSecretsOfPurpose(tx, key, PURPOSE);
          return {
            generation,
            connections,
            repositories,
            mcpServers: servers,
            stored,
            invalid,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    generation: () => generationIn(db),

    importSettings(entries) {
      return db.transaction(async (tx) => {
        const inserted: string[] = [];
        const conflicts: string[] = [];
        for (const [id, provider] of Object.entries(entries.connections)) {
          const [row] = await tx
            .insert(providerConnections)
            .values({
              id,
              definition: provider,
              credentialSource: sourceOf(provider.auth),
              origin: "import",
            })
            .onConflictDoNothing()
            .returning({ id: providerConnections.id });
          if (row) {
            inserted.push(`connection:${id}`);
            continue;
          }
          const [held] = await tx
            .select({ definition: providerConnections.definition })
            .from(providerConnections)
            .where(eq(providerConnections.id, id));
          if (canonicalJson(held?.definition) !== canonicalJson(provider)) {
            conflicts.push(`connection:${id}`);
          }
        }
        for (const [id, repository] of Object.entries(entries.repositories)) {
          const { auth } = repository;
          if (auth !== undefined && isRegisteredGitHubApp(auth)) {
            throw new Error(
              `repository ${id} uses the console's GitHub App; the repository seed brings it`,
            );
          }
          const ref = repoRefOf(repository.url);
          const [row] = await tx
            .insert(catalogRepositories)
            .values({
              id,
              owner: ref?.owner ?? "",
              name: ref?.name ?? "",
              url: repository.url,
              branch: repository.branch,
              profiles: repository.profiles ?? null,
              authKind: authKindOf(auth),
              auth: auth ?? null,
              credentialSource: auth === undefined ? null : sourceOf(auth),
              source: "import",
            })
            .onConflictDoNothing()
            .returning({ id: catalogRepositories.id });
          if (row) {
            inserted.push(`repository:${id}`);
            continue;
          }
          const [held] = await tx
            .select()
            .from(catalogRepositories)
            .where(eq(catalogRepositories.id, id));
          if (
            held === undefined ||
            canonicalJson(repositoryConfigOf(held)) !== canonicalJson(repository)
          ) {
            conflicts.push(`repository:${id}`);
          }
        }
        for (const [id, server] of Object.entries(entries.mcpServers)) {
          const [row] = await tx
            .insert(mcpServers)
            .values({
              id,
              url: server.url,
              credentialRef: server.credential_ref,
              auth: server.auth,
              credentialSource: sourceOf(server.auth),
              workspaces: server.workspaces,
              origin: "import",
            })
            .onConflictDoNothing()
            .returning({ id: mcpServers.id });
          if (row) {
            inserted.push(`mcp:${id}`);
            continue;
          }
          const [held] = await tx
            .select()
            .from(mcpServers)
            .where(eq(mcpServers.id, id));
          if (
            held === undefined ||
            canonicalJson(mcpConfigOf(held)) !== canonicalJson(server)
          ) {
            conflicts.push(`mcp:${id}`);
          }
        }
        return { inserted, conflicts };
      });
    },

    putStoredValue(owner, value, updatedBy) {
      if (key === null) {
        return Promise.reject(
          new Error("the secret store is off: no value can be stored"),
        );
      }
      return db.transaction(async (tx) => {
        // The table wants a workspace; an installation has one
        // (settings-replace-file-catalog.md §2).
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
          .limit(1);
        if (!workspace) {
          throw new Error("no workspace yet to keep a stored value under");
        }
        await writeSecretInTx(
          tx,
          key,
          { workspaceId: workspace.id, owner, purpose: PURPOSE },
          value,
          updatedBy,
        );
      });
    },
  };
}

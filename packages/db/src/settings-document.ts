import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@werft-ai/contracts";
import {
  type CatalogRepositoryConfig,
  credentialSourceOf,
  type ExistingSettings,
  type ExistingSettingsEntry,
  planSettingsImport,
  repositoryAuthKindOf,
  repositoryNameOf,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsImportAdd,
  type TeamActor,
} from "@werft-ai/platform";
import { and, asc, eq, sql } from "drizzle-orm";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { lockSettingsGeneration } from "./installation-settings.ts";
import type { Database } from "./queries.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  receipts,
  secretValues,
  workspaces,
} from "./schema.ts";

const PURPOSE = "settings_credential";

type RepositoryRow = typeof catalogRepositories.$inferSelect;
type McpRow = typeof mcpServers.$inferSelect;

/** The row as its settings entry: what the file would have spelled. */
function repositoryEntryOf(row: RepositoryRow): unknown {
  const auth =
    row.authKind === "github_app" ? { kind: "github_app" } : row.auth;
  return {
    url: row.url,
    branch: row.branch,
    ...(row.profiles === null ? {} : { profiles: row.profiles }),
    ...(auth === null ? {} : { auth }),
  };
}

function mcpEntryOf(row: McpRow): unknown {
  return {
    url: row.url,
    credential_ref: row.credentialRef,
    auth: row.auth,
    workspaces: row.workspaces,
  };
}

async function firstWorkspace(tx: Database): Promise<string | null> {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return workspace?.id ?? null;
}

/** Each stored value's last four characters, by `<kind>:<id>`. */
async function storedLast4(
  tx: Database,
  workspaceId: string | null,
): Promise<Map<string, string>> {
  if (workspaceId === null) return new Map();
  const rows = await tx
    .select({ ownerRef: secretValues.ownerRef, last4: secretValues.last4 })
    .from(secretValues)
    .where(
      and(
        eq(secretValues.workspaceId, workspaceId),
        eq(secretValues.purpose, PURPOSE),
      ),
    );
  return new Map(rows.map((row) => [row.ownerRef, row.last4]));
}

async function existingIn(
  tx: Database,
  workspaceId: string | null,
): Promise<ExistingSettings> {
  const values = await storedLast4(tx, workspaceId);
  const entryOf = (
    kind: string,
    id: string,
    entry: unknown,
    active: boolean,
  ): [string, ExistingSettingsEntry] => [
    id,
    { entry, active, has_value: values.has(`${kind}:${id}`) },
  ];
  return {
    connections: new Map(
      (await tx.select().from(providerConnections)).map((row) =>
        entryOf("connection", row.id, row.definition, row.disabledAt === null),
      ),
    ),
    repositories: new Map(
      (await tx.select().from(catalogRepositories)).map((row) =>
        entryOf(
          "repository",
          row.id,
          repositoryEntryOf(row),
          row.removedAt === null,
        ),
      ),
    ),
    mcp_servers: new Map(
      (await tx.select().from(mcpServers)).map((row) =>
        entryOf("mcp", row.id, mcpEntryOf(row), row.disabledAt === null),
      ),
    ),
    stored_values: new Set(values.keys()),
  };
}

async function insertRow(
  tx: Database,
  add: SettingsImportAdd,
  createdBy: string | null,
): Promise<void> {
  const source = credentialSourceOf(add.entry);
  switch (add.kind) {
    case "connection":
      await tx.insert(providerConnections).values({
        id: add.id,
        definition: add.entry,
        // A provider always names a credential.
        credentialSource: source ?? "external",
        origin: "import",
        createdBy,
      });
      return;
    case "repository": {
      const authKind = repositoryAuthKindOf(add.entry);
      const { owner, name } = repositoryNameOf(add.entry);
      const own = authKind !== "github_app" && authKind !== "none";
      await tx.insert(catalogRepositories).values({
        id: add.id,
        owner,
        name,
        url: add.entry.url,
        branch: add.entry.branch,
        profiles: add.entry.profiles ? [...add.entry.profiles] : null,
        authKind,
        auth: own
          ? (add.entry.auth as Record<string, unknown> | undefined)
          : null,
        credentialSource: own ? source : null,
        // The console App's rows hold no GitHub id until a pick fills it,
        // which the table takes from a seeded row only.
        source: authKind === "github_app" ? "seed" : "import",
        createdBy,
        updatedBy: createdBy,
      });
      return;
    }
    case "mcp":
      await tx.insert(mcpServers).values({
        id: add.id,
        url: add.entry.url,
        credentialRef: add.entry.credential_ref,
        auth: add.entry.auth,
        credentialSource: source ?? "external",
        workspaces: [...add.entry.workspaces],
        origin: "import",
        createdBy,
      });
      return;
  }
}

const OPERATIONS = {
  connection: "import_connection",
  repository: "import_repository",
  mcp: "import_mcp_server",
} as const;

function auditOf(add: SettingsImportAdd): Record<string, unknown> {
  const credential_source = credentialSourceOf(add.entry);
  switch (add.kind) {
    case "connection":
      return {
        connection_id: add.id,
        kind: add.entry.kind,
        endpoint: add.entry.endpoint,
        credential_source,
      };
    case "repository": {
      const entry: CatalogRepositoryConfig = add.entry;
      return {
        repository_id: add.id,
        url: entry.url,
        branch: entry.branch,
        auth_kind: repositoryAuthKindOf(entry),
        credential_source,
        source: "settings_document",
      };
    }
    case "mcp":
      return {
        mcp_server_id: add.id,
        url: add.entry.url,
        credential_ref: add.entry.credential_ref,
        credential_source,
      };
  }
}

export function createPostgresSettingsDocumentStore(
  db: Database,
): SettingsDocumentStore {
  return {
    exportEntries() {
      return db.transaction(
        async (tx) => {
          const last4 = await storedLast4(tx, await firstWorkspace(tx));
          const entries: SettingsEntries = {
            connections: {},
            repositories: {},
            mcp_servers: {},
          };
          for (const row of await tx.select().from(providerConnections)) {
            if (row.disabledAt !== null) continue;
            entries.connections[row.id] =
              row.definition as SettingsEntries["connections"][string];
          }
          for (const row of await tx.select().from(catalogRepositories)) {
            if (row.removedAt !== null) continue;
            entries.repositories[row.id] = repositoryEntryOf(
              row,
            ) as CatalogRepositoryConfig;
          }
          for (const row of await tx.select().from(mcpServers)) {
            if (row.disabledAt !== null) continue;
            entries.mcp_servers[row.id] = mcpEntryOf(
              row,
            ) as SettingsEntries["mcp_servers"][string];
          }
          return { entries, last4 };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    importEntries(entries, options) {
      return db.transaction(async (tx) => {
        // The repository writers' order: their advisory lock, then the
        // generation, then rows.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'))`,
        );
        await lockSettingsGeneration(tx);
        const { actor } = options;
        if (actor !== null && !(await liveOwner(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const workspaceId = await firstWorkspace(tx);
        const plan = planSettingsImport(
          entries,
          await existingIn(tx, workspaceId),
          { allowExternal: options.allowExternal },
        );
        if (plan.conflicts.length > 0 || plan.refused_external.length > 0) {
          return { ...plan, outcome: "refused" as const, receipt_ids: [] };
        }
        if (options.dryRun) {
          return { ...plan, outcome: "dry_run" as const, receipt_ids: [] };
        }
        const receiptActor: ReceiptActor | null =
          actor === null ? null : receiptActorOf(actor.principal);
        const receipt_ids: string[] = [];
        for (const add of plan.add) {
          await insertRow(tx, add, actor?.userId ?? null);
          const target = actor?.workspaceId ?? workspaceId;
          // Before bootstrap there is no workspace to keep a receipt for.
          if (target === null) continue;
          const id = randomUUID();
          await tx.insert(receipts).values({
            id,
            ownerId: actor?.principal.ownerId ?? target,
            actor: receiptActor,
            operation: OPERATIONS[add.kind],
            targetRef: {
              resource: { kind: "workspace", id: target },
              workspace_id: target,
            },
            result: auditOf(add),
            status: "succeeded",
            requestId: actor?.principal.requestId ?? null,
          });
          receipt_ids.push(id);
        }
        return { ...plan, outcome: "applied" as const, receipt_ids };
      });
    },
  };
}

async function liveOwner(tx: Database, actor: TeamActor): Promise<boolean> {
  const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
  return me?.live === true && me.role === "owner";
}

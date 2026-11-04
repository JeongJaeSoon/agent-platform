import type {
  AuthorizationAction,
  CreateSettingsConnectionRequest,
  CreateSettingsMcpServerRequest,
  CreateSettingsRepositoryRequest,
  ListSettingsConnectionsResponse,
  ListSettingsMcpServersResponse,
  ListSettingsRepositoriesResponse,
  SettingsChangeResponse,
  SettingsConnection,
  SettingsCredentialView,
  SettingsEntryOrigin,
  SettingsEntryState,
  SettingsMcpServer,
  SettingsRepository,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type {
  SettingsConsoleResult,
  SettingsDocumentStore,
  SettingsRow,
} from "../ports/settings-document-store.ts";
import type { TeamActor } from "../ports/team-store.ts";
import type {
  CatalogMcpServerConfig,
  CatalogProfileConfig,
  CatalogRepositoryConfig,
} from "./catalog.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";
import {
  parseSettingsDocument,
  repositoryAuthKindOf,
  SettingsDocumentError,
  type SettingsEntries,
  type SettingsImportAdd,
  type SettingsKind,
} from "./settings-document.ts";

type Provider = CatalogProfileConfig["provider"];

const ACTION: Record<SettingsKind, AuthorizationAction> = {
  connection: "installation.settings.manage",
  mcp: "installation.settings.manage",
  repository: "workspace.manage",
};

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds the role this setting needs",
    undefined,
    { reason_code: "role" },
  );

const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
  );

function credentialOf(
  auth: unknown,
  last4: string | null,
): SettingsCredentialView {
  if (auth === null || typeof auth !== "object") return { source: "none" };
  const ref = auth as Record<string, unknown>;
  if (typeof ref.stored === "string") return { source: "stored", last4 };
  return {
    source: "external",
    ...(typeof ref.value_env === "string" ? { value_env: ref.value_env } : {}),
    ...(typeof ref.secret_id === "string" ? { secret_id: ref.secret_id } : {}),
  };
}

/**
 * The installation settings from the console (settings-replace-file-catalog.md
 * §2-§4): the owner makes connections and MCP servers with a value they
 * type, replaces that value or disables the row; owners and admins add a
 * PAT or public repository by URL. Writes go through the settings
 * document store's own transaction and locks; no destination and no
 * operator reference is ever written here.
 */
export function createSettingsConsoleService(deps: {
  authorization: AuthorizationPolicy;
  store: SettingsDocumentStore;
  /** This replica's `<kind>:<id>` rows whose credential did not resolve. */
  leftOut: () => ReadonlyArray<{ entry: string }>;
  secretStoreOn: boolean;
  /** EGRESS_CREDENTIAL_ALLOWLIST as `host:port`, or null when not given. */
  credentialHosts: readonly string[] | null;
  /** Reads the settings again after a write committed; never throws. */
  reread: () => Promise<void>;
}) {
  const { store } = deps;

  async function writer(
    caller: Caller,
    kind: SettingsKind,
  ): Promise<TeamActor> {
    await requirePermitted(deps.authorization, caller, ACTION[kind], {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person manages the installation settings",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  function stateOf(kind: SettingsKind, row: SettingsRow): SettingsEntryState {
    if (row.disabledAt !== null) return "disabled";
    const auth = (row.entry as { auth?: { stored?: unknown } }).auth;
    if (typeof auth?.stored === "string" && row.last4 === null) {
      return "needs_value";
    }
    const ref = `${kind}:${row.id}`;
    if (deps.leftOut().some((left) => left.entry === ref)) return "unresolved";
    return "active";
  }

  async function rowItems<T>(
    kind: SettingsKind,
    view: (
      id: string,
      entry: unknown,
      meta: {
        origin: SettingsEntryOrigin;
        state: SettingsEntryState;
        last4: string | null;
        created_at: string;
        disabled_at: string | null;
      },
    ) => T | null,
  ): Promise<T[]> {
    const rows = await store.listRows(kind);
    const items: Array<{ id: string; item: T }> = [];
    for (const row of rows) {
      const item = view(row.id, row.entry, {
        origin: row.origin,
        state: stateOf(kind, row),
        last4: row.last4,
        created_at: row.createdAt.toISOString(),
        disabled_at: row.disabledAt?.toISOString() ?? null,
      });
      if (item !== null) items.push({ id: row.id, item });
    }
    return items
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ item }) => item);
  }

  function invalid(error: unknown): never {
    if (error instanceof SettingsDocumentError) {
      throw new SessionServiceError(
        "BAD_REQUEST",
        error.message.replace(/^The settings document is invalid: /, ""),
        undefined,
        { reason_code: "invalid_entry" },
      );
    }
    throw error;
  }

  /** The entry under the catalog's rules, `stored` naming its own row. */
  function parsed(
    section: keyof SettingsEntries,
    id: string,
    entry: Record<string, unknown>,
  ): SettingsImportAdd {
    let entries: SettingsEntries;
    try {
      entries = parseSettingsDocument({
        version: 1,
        connections: {},
        repositories: {},
        mcp_servers: {},
        [section]: { [id]: entry },
      });
    } catch (error) {
      invalid(error);
    }
    if (section === "connections") {
      return {
        kind: "connection",
        id,
        entry: entries.connections[id] as Provider,
      };
    }
    if (section === "mcp_servers") {
      return {
        kind: "mcp",
        id,
        entry: entries.mcp_servers[id] as CatalogMcpServerConfig,
      };
    }
    return {
      kind: "repository",
      id,
      entry: entries.repositories[id] as CatalogRepositoryConfig,
    };
  }

  async function settled(
    result: SettingsConsoleResult,
    id: string,
  ): Promise<SettingsChangeResponse> {
    switch (result.outcome) {
      case "done":
        await deps.reread();
        return { id, receipt_id: result.receiptId };
      case "actor_inactive":
        throw OUTRANKED();
      case "not_found":
        throw new SessionServiceError(
          "NOT_FOUND",
          `No settings row ${id} the console manages`,
        );
      case "conflict":
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          result.reason === "already_exists"
            ? `${id} is taken: an id is never reused, even after it is disabled`
            : result.reason === "not_stored"
              ? `${id} takes its credential from the operator's deployment; the console only shows and disables it`
              : `${id} is disabled`,
          undefined,
          { reason_code: result.reason },
        );
    }
  }

  async function create(
    caller: Caller,
    kind: SettingsKind,
    add: () => SettingsImportAdd,
    value: string | null,
  ): Promise<SettingsChangeResponse> {
    const actor = await writer(caller, kind);
    const entry = add();
    if (value !== null && !deps.secretStoreOn) throw STORE_OFF();
    return settled(await store.create(entry, value, actor), entry.id);
  }

  async function onRow(
    caller: Caller,
    kind: SettingsKind,
    id: string,
    write: (actor: TeamActor) => Promise<SettingsConsoleResult>,
  ): Promise<SettingsChangeResponse> {
    const actor = await writer(caller, kind);
    return settled(await write(actor), id);
  }

  return {
    async listConnections(
      caller: Caller,
    ): Promise<ListSettingsConnectionsResponse> {
      await writer(caller, "connection");
      const items = await rowItems<SettingsConnection>(
        "connection",
        (id, entry, meta) => {
          const provider = entry as Provider;
          return {
            id,
            origin: meta.origin,
            state: meta.state,
            kind: provider.kind,
            endpoint: provider.endpoint,
            billing: provider.billing === "none" ? "none" : "per_token",
            auth_kind: provider.auth.kind,
            credential: credentialOf(provider.auth, meta.last4),
            created_at: meta.created_at,
            disabled_at: meta.disabled_at,
          };
        },
      );
      return {
        items,
        credential_hosts:
          deps.credentialHosts === null ? null : [...deps.credentialHosts],
      };
    },

    async listMcpServers(
      caller: Caller,
    ): Promise<ListSettingsMcpServersResponse> {
      await writer(caller, "mcp");
      const items = await rowItems<SettingsMcpServer>(
        "mcp",
        (id, entry, meta) => {
          const server = entry as CatalogMcpServerConfig;
          return {
            id,
            origin: meta.origin,
            state: meta.state,
            url: server.url,
            credential_ref: server.credential_ref,
            workspaces: [...server.workspaces],
            credential: credentialOf(server.auth, meta.last4),
            created_at: meta.created_at,
            disabled_at: meta.disabled_at,
          };
        },
      );
      return { items };
    },

    async listRepositories(
      caller: Caller,
    ): Promise<ListSettingsRepositoriesResponse> {
      await writer(caller, "repository");
      const items = await rowItems<SettingsRepository>(
        "repository",
        (id, entry, meta) => {
          const repository = entry as CatalogRepositoryConfig;
          const authKind = repositoryAuthKindOf(repository);
          // The console App's repositories are the GitHub screen's.
          if (authKind === "github_app") return null;
          const auth = repository.auth as
            | { username?: string | undefined }
            | undefined;
          return {
            id,
            origin: meta.origin,
            state: meta.state,
            url: repository.url,
            branch: repository.branch,
            auth_kind: authKind,
            ...(auth?.username === undefined
              ? {}
              : { username: auth.username }),
            credential: credentialOf(repository.auth, meta.last4),
            created_at: meta.created_at,
            disabled_at: meta.disabled_at,
          };
        },
      );
      return { items };
    },

    createConnection(caller: Caller, request: CreateSettingsConnectionRequest) {
      return create(
        caller,
        "connection",
        () =>
          parsed("connections", request.id, {
            kind: request.kind,
            endpoint: request.endpoint,
            auth: { kind: request.auth_kind, stored: true },
            ...(request.billing === undefined
              ? {}
              : { billing: request.billing }),
          }),
        request.value,
      );
    },

    createMcpServer(caller: Caller, request: CreateSettingsMcpServerRequest) {
      return create(
        caller,
        "mcp",
        () =>
          parsed("mcp_servers", request.id, {
            url: request.url,
            credential_ref: request.credential_ref,
            auth: { kind: "bearer", stored: true },
            workspaces: request.workspaces,
          }),
        request.value,
      );
    },

    createRepository(caller: Caller, request: CreateSettingsRepositoryRequest) {
      const { auth } = request;
      return create(
        caller,
        "repository",
        () =>
          parsed("repositories", request.id, {
            url: request.url,
            branch: request.branch,
            ...(auth.kind === "none"
              ? {}
              : {
                  auth: {
                    kind: auth.kind,
                    ...(auth.kind === "basic"
                      ? { username: auth.username }
                      : {}),
                    stored: true,
                  },
                }),
          }),
        auth.kind === "none" ? null : auth.value,
      );
    },

    setCredential(
      caller: Caller,
      kind: SettingsKind,
      id: string,
      value: string,
    ) {
      if (!deps.secretStoreOn) {
        return writer(caller, kind).then(() => {
          throw STORE_OFF();
        });
      }
      return onRow(caller, kind, id, (actor) =>
        store.setValue({ kind, id }, value, actor),
      );
    },

    disable(caller: Caller, kind: SettingsKind, id: string) {
      return onRow(caller, kind, id, (actor) =>
        store.disable({ kind, id }, actor),
      );
    },

    setMcpWorkspaces(caller: Caller, id: string, workspaces: string[]) {
      // The catalog's rule for the field (catalogMcpServerSchema).
      if (new Set(workspaces).size !== workspaces.length) {
        return Promise.reject(
          new SessionServiceError(
            "BAD_REQUEST",
            "workspaces: must not repeat a workspace",
            undefined,
            { reason_code: "invalid_entry" },
          ),
        );
      }
      return onRow(caller, "mcp", id, (actor) =>
        store.setMcpWorkspaces(id, workspaces, actor),
      );
    },

    setRepositoryBranch(caller: Caller, id: string, branch: string) {
      return onRow(caller, "repository", id, (actor) =>
        store.setRepositoryBranch(id, branch, actor),
      );
    },
  };
}

export type SettingsConsoleService = ReturnType<
  typeof createSettingsConsoleService
>;

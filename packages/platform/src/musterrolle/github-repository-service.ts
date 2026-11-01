import { randomUUID } from "node:crypto";
import type {
  CatalogGitHubRepository,
  GitHubRepositoryPageQuery,
  GitHubRepositoryWriteResponse,
  InstalledGitHubRepository,
  ListAgentGitHubRepositoriesResponse,
  ListGitHubRepositoriesResponse,
  PatchGitHubRepositoryRequest,
  PickAgentGitHubRepositoryRequest,
  PickAgentGitHubRepositoryResponse,
} from "@werft-ai/contracts";
import type { AgentStore } from "../ports/agent-store.ts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import {
  GitHubAppCheckError,
  type GitHubAppCredential,
  type GitHubAppDirectory,
  type GitHubAppStore,
  type GitHubInstallationRepository,
} from "../ports/github-app-store.ts";
import {
  type CatalogProfileView,
  type CatalogRepository,
  ceilingAppRepositories,
  type ProfileLookup,
} from "../sessions/catalog.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  receiptActorOf,
} from "./policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND } from "./service-errors.ts";

type Unavailable = NonNullable<ListGitHubRepositoriesResponse["unavailable"]>;
type InstallationPage = Pick<
  ListGitHubRepositoriesResponse,
  "installations" | "installation_id" | "page" | "per_page" | "total_count"
> & {
  repositories: GitHubInstallationRepository[];
  unavailable: Unavailable | null;
};
type Credential = Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">;

/** How many resolved rows the list asks GitHub about, one call each. */
export const CATALOG_INSTALLED_CHECK_MAX = 100;

const refused = (reasonCode: string, message: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
  });

const unreachable = (reasonCode: Unavailable) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "GitHub could not be reached to read the App's repositories",
    undefined,
    { reason_code: reasonCode },
  );

const failureOf = (error: unknown): Unavailable =>
  error instanceof GitHubAppCheckError && error.reason === "github_rejected"
    ? "github_rejected"
    : "github_unreachable";

/** A catalog id from a GitHub repository name: `My.Repo` → `my.repo`. */
export function repositoryIdBase(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 90);
  return id === "" ? "repository" : id;
}

const fullNameOf = (owner: string, name: string) =>
  `${owner}/${name}`.toLowerCase();

const emptyPage = (
  query: GitHubRepositoryPageQuery,
  unavailable: Unavailable | null,
): InstallationPage => ({
  installations: [],
  installation_id: null,
  page: query.page,
  per_page: query.per_page,
  total_count: 0,
  repositories: [],
  unavailable,
});

/**
 * The console's GitHub App repositories (settings-replace-file-catalog.md
 * §1.1): read from the author App's installations a page at a time, never
 * registered. A pick resolves one to a catalog row, which a release names;
 * the operator file's entries stay read-only beside them.
 */
export function createGitHubRepositoryService(deps: {
  authorization: AuthorizationPolicy;
  store: CatalogRepositoryStore;
  /** Null when the API runs without a master key. */
  apps: GitHubAppStore | null;
  directory: GitHubAppDirectory;
  agents: Pick<AgentStore, "get">;
  /** For the ceiling of an agent's active release. */
  catalog: ProfileLookup<CatalogProfileView>;
  /** The operator file's repositories, as resolved at startup. */
  fileRepositories: Readonly<Record<string, CatalogRepository>>;
  /** Called after a write commits, so this replica's catalog picks it up. */
  changed: () => Promise<void>;
  newId?: () => string;
}) {
  const { authorization, directory, store } = deps;
  const newId = deps.newId ?? randomUUID;
  const fileEntries = Object.entries(deps.fileRepositories).filter(
    ([, repository]) => {
      const auth = repository.auth;
      if (auth?.kind === "github_app") return !("registered" in auth);
      try {
        return new URL(repository.url).hostname === "github.com";
      } catch {
        return false;
      }
    },
  );
  // The file ids that stay in the file, GitHub or not: a row may not shadow
  // them. A registered-App entry is the seed of a row, so it is the row's.
  const reserved = new Set(
    Object.entries(deps.fileRepositories)
      .filter(([, repository]) => {
        const auth = repository.auth;
        return !(auth?.kind === "github_app" && "registered" in auth);
      })
      .map(([id]) => id),
  );

  /** A signed-in console user: picks and branch changes are not for keys. */
  function writer(caller: Caller) {
    const actor = receiptActorOf(caller);
    const userId = actor?.actor_user_id ?? null;
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      actor === null ||
      userId === null
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Repositories are chosen from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return {
      workspaceId: caller.ownerId,
      userId,
      actor,
      requestId: caller.requestId,
    };
  }

  async function managed(caller: Caller, workspaceId: string) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    return writer(caller);
  }

  const manageAgent = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "agent.manage", {
      kind: "agent",
      id: agentId,
    });

  // After a write has committed, a failed reload must not report it failed;
  // the periodic one catches up.
  const reload = () => deps.changed().catch(() => undefined);

  async function credential(workspaceId: string): Promise<Credential | null> {
    if (deps.apps === null) return null;
    const record = await deps.apps.find(workspaceId, "author");
    if (record === null) return null;
    return (
      (await deps.apps.credentials("author", workspaceId)).find(
        (held) => held.id === record.id,
      ) ?? null
    );
  }

  async function installationPage(
    workspaceId: string,
    query: GitHubRepositoryPageQuery,
  ): Promise<InstallationPage> {
    const app = await credential(workspaceId);
    if (app === null) return emptyPage(query, "no_author_app");
    try {
      const installations = (await directory.installations(app))
        .map(({ id, account }) => ({ id, account }))
        .sort((a, b) => a.account.localeCompare(b.account) || a.id - b.id);
      const first = installations[0];
      if (first === undefined) return emptyPage(query, "no_installation");
      const installation =
        query.installation_id === undefined
          ? first
          : installations.find((held) => held.id === query.installation_id);
      if (installation === undefined) {
        throw refused(
          "not_installed",
          "The author App has no installation with that id",
        );
      }
      const page = await directory.installationRepositoriesPage(
        app,
        installation.id,
        { page: query.page, perPage: query.per_page },
      );
      return {
        installations,
        installation_id: installation.id,
        page: query.page,
        per_page: query.per_page,
        total_count: page.totalCount,
        repositories: page.repositories,
        unavailable: null,
      };
    } catch (error) {
      if (error instanceof SessionServiceError) throw error;
      return emptyPage(query, failureOf(error));
    }
  }

  /** The file id that already holds that github.com repository. */
  const fileHolder = (repository: { owner: string; name: string }) =>
    fileEntries
      .map(fileView)
      .find(
        (entry) =>
          entry.full_name !== null &&
          entry.full_name.toLowerCase() ===
            fullNameOf(repository.owner, repository.name),
      )?.id;

  const pickedOf = (
    repository: GitHubInstallationRepository,
    rows: readonly CatalogRepositoryRow[],
  ): InstalledGitHubRepository => ({
    github_repository_id: repository.id,
    full_name: `${repository.owner}/${repository.name}`,
    default_branch: repository.defaultBranch,
    private: repository.private,
    catalog_id:
      rows.find(
        (row) =>
          row.github_repository_id === repository.id ||
          fullNameOf(row.owner, row.name) ===
            fullNameOf(repository.owner, repository.name),
      )?.id ?? null,
  });

  const rowView = (
    row: CatalogRepositoryRow,
    installed: boolean | null,
  ): CatalogGitHubRepository => ({
    id: row.id,
    github_repository_id: row.github_repository_id,
    full_name: `${row.owner}/${row.name}`,
    url: row.url,
    branch: row.branch,
    source: row.source,
    editable: true,
    version: row.version,
    installed,
    updated_at: row.updated_at,
  });

  function fileView([id, repository]: [
    string,
    CatalogRepository,
  ]): CatalogGitHubRepository {
    const path = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      new URL(repository.url).pathname,
    );
    return {
      id,
      github_repository_id: null,
      full_name: path ? `${path[1]}/${path[2]}` : null,
      url: repository.url,
      branch: repository.branch,
      source: "file",
      editable: false,
      version: null,
      installed: null,
      updated_at: null,
    };
  }

  /** Whether an installation of the App covers the row; null when unknown. */
  async function installedNow(
    app: Credential | null,
    row: CatalogRepositoryRow,
  ): Promise<boolean | null> {
    if (app === null) return null;
    try {
      return (
        (await directory.installationFor(app, {
          owner: row.owner,
          name: row.name,
        })) !== null
      );
    } catch {
      return null;
    }
  }

  async function rowViews(
    workspaceId: string,
    rows: readonly CatalogRepositoryRow[],
  ): Promise<CatalogGitHubRepository[]> {
    const app = await credential(workspaceId);
    return Promise.all(
      rows.map(async (row, index) =>
        rowView(
          row,
          index < CATALOG_INSTALLED_CHECK_MAX
            ? await installedNow(app, row)
            : null,
        ),
      ),
    );
  }

  /** The active release's repositories may be picked among the App's. */
  async function installedCeiling(workspaceId: string, agentId: string) {
    const detail = await deps.agents.get(workspaceId, agentId);
    if (detail === null) throw NOT_FOUND();
    const release = detail.active_release;
    if (release === null) return "no_active_release" as const;
    return ceilingAppRepositories(deps.catalog, release.runtime_profile_id) ===
      "installed"
      ? null
      : ("ceiling_listed" as const);
  }

  /**
   * The repository with that id, only when the installation named covers
   * it: a public repository reads by id from any installation's token, so
   * the App's own answer for its name decides.
   */
  async function coveredRepository(
    app: Credential,
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubInstallationRepository | null> {
    const repository = await directory.repositoryById(
      app,
      installationId,
      repositoryId,
    );
    if (repository === null) return null;
    const found = await directory.installationFor(app, {
      owner: repository.owner,
      name: repository.name,
    });
    return found?.id === installationId ? repository : null;
  }

  return {
    async list(
      caller: Caller,
      workspaceId: string,
      query: GitHubRepositoryPageQuery,
    ): Promise<ListGitHubRepositoriesResponse> {
      await managed(caller, workspaceId);
      const [page, rows, counts] = await Promise.all([
        installationPage(workspaceId, query),
        store.listActive(),
        store.agentCounts(),
      ]);
      const own = rows.filter((row) => !reserved.has(row.id));
      return {
        ...page,
        repositories: page.repositories.map((repository) => {
          const picked = pickedOf(repository, own);
          return {
            ...picked,
            catalog_id: picked.catalog_id ?? fileHolder(repository) ?? null,
            agent_count:
              picked.catalog_id === null
                ? 0
                : (counts.get(picked.catalog_id) ?? 0),
          };
        }),
        catalog: [
          ...(await rowViews(workspaceId, own)),
          ...fileEntries.map(fileView),
        ],
      };
    },

    async setBranch(
      caller: Caller,
      workspaceId: string,
      repositoryId: string,
      readBody: () => Promise<PatchGitHubRepositoryRequest>,
    ): Promise<GitHubRepositoryWriteResponse> {
      const write = await managed(caller, workspaceId);
      if (reserved.has(repositoryId)) {
        throw refused(
          "file_repository",
          "The operator's file holds this repository; change it there",
        );
      }
      const body = await readBody();
      const receiptId = newId();
      const result = await store.setBranch({
        ...write,
        receiptId,
        id: repositoryId,
        branch: body.branch,
        version: body.version,
      });
      switch (result.outcome) {
        case "stored": {
          await reload();
          const [repository] = await rowViews(workspaceId, [result.repository]);
          if (repository === undefined) throw NOT_FOUND();
          return { repository, receipt_id: receiptId };
        }
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The repository changed since it was read; read it again",
          );
        case "not_found":
          throw NOT_FOUND();
        default:
          throw ACTOR_INACTIVE();
      }
    },

    async agentPage(
      caller: Caller,
      agentId: string,
      query: GitHubRepositoryPageQuery,
    ): Promise<ListAgentGitHubRepositoriesResponse> {
      await manageAgent(caller, agentId);
      const workspaceId = caller.ownerId;
      const blocked = await installedCeiling(workspaceId, agentId);
      if (blocked !== null) {
        return {
          ...emptyPage(query, null),
          repositories: [],
          unavailable: blocked,
        };
      }
      const [page, rows] = await Promise.all([
        installationPage(workspaceId, query),
        store.listActive(),
      ]);
      const own = rows.filter((row) => !reserved.has(row.id));
      return {
        ...page,
        repositories: page.repositories.map((repository) =>
          pickedOf(repository, own),
        ),
      };
    },

    /**
     * `readBody` runs only once the caller is allowed, so a refused caller
     * learns nothing about the request body.
     */
    async pick(
      caller: Caller,
      agentId: string,
      readBody: () => Promise<PickAgentGitHubRepositoryRequest>,
    ): Promise<PickAgentGitHubRepositoryResponse> {
      await manageAgent(caller, agentId);
      const write = writer(caller);
      const body = await readBody();
      if ((await installedCeiling(write.workspaceId, agentId)) !== null) {
        throw refused(
          "repository_not_allowed",
          "The active release's ceiling does not run on the App's repositories",
        );
      }
      const app = await credential(write.workspaceId);
      if (app === null) {
        throw refused(
          "no_author_app",
          "Register the author GitHub App before choosing repositories",
        );
      }
      let picked: GitHubInstallationRepository | null;
      try {
        // A rename between the two reads makes the name miss once.
        picked =
          (await coveredRepository(
            app,
            body.installation_id,
            body.github_repository_id,
          )) ??
          (await coveredRepository(
            app,
            body.installation_id,
            body.github_repository_id,
          ));
      } catch (error) {
        throw unreachable(failureOf(error));
      }
      if (picked === null) {
        throw refused(
          "not_installed",
          "That installation of the author App does not cover the repository",
        );
      }
      if (fileHolder(picked) !== undefined) {
        throw refused(
          "file_repository",
          "The operator's file holds that repository with its own credential",
        );
      }
      const receiptId = newId();
      // The URL and branch come from GitHub's answer, never from the body.
      const result = await store.resolve({
        ...write,
        receiptId,
        base: repositoryIdBase(picked.name),
        reserved,
        githubRepositoryId: picked.id,
        owner: picked.owner,
        name: picked.name,
        url: `https://github.com/${picked.owner}/${picked.name}.git`,
        branch: picked.defaultBranch,
      });
      if (result.outcome === "name_held") {
        throw refused(
          "name_held",
          `Catalog row ${result.id} holds that name for another GitHub repository; pick the repository it was (now renamed) to update it`,
        );
      }
      if (result.outcome !== "resolved") throw ACTOR_INACTIVE();
      if (result.changed) await reload();
      return {
        catalog_id: result.repository.id,
        receipt_id: result.created ? receiptId : null,
      };
    },
  };
}

export type GitHubRepositoryService = ReturnType<
  typeof createGitHubRepositoryService
>;

import { randomUUID } from "node:crypto";
import type {
  CatalogGitHubRepository,
  DeleteGitHubRepositoryResponse,
  GitHubRepositoryCandidate,
  GitHubRepositoryWriteResponse,
  ListGitHubRepositoriesResponse,
  ListGitHubRepositoryCandidatesResponse,
  PatchGitHubRepositoryRequest,
  PostGitHubRepositoryRequest,
} from "@werft-ai/contracts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import {
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppStore,
  type GitHubInstallationRepository,
} from "../ports/github-app-store.ts";
import type { CatalogRepository } from "../sessions/catalog.ts";
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

type Candidates = ListGitHubRepositoryCandidatesResponse["unavailable"];
type Installed = GitHubInstallationRepository & { account: string };

const refused = (reasonCode: string, message: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
  });

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

/**
 * The catalog's GitHub repositories as the console manages them
 * (repository-catalog-db.md §5): rows picked from the author App's
 * installations, beside the operator file's entries, which stay read-only.
 */
export function createGitHubRepositoryService(deps: {
  authorization: AuthorizationPolicy;
  store: CatalogRepositoryStore;
  /** Null when the API runs without a master key. */
  apps: GitHubAppStore | null;
  directory: GitHubAppDirectory;
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
  // Every id in the file, GitHub or not: a row may not shadow any of them.
  const reserved = new Set(Object.keys(deps.fileRepositories));

  async function managed(caller: Caller, workspaceId: string) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
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
        "Repositories are managed from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return {
      workspaceId,
      userId,
      actor,
      requestId: caller.requestId,
    };
  }

  // After a write has committed, a failed reload must not report it failed;
  // the periodic one catches up.
  const reload = () => deps.changed().catch(() => undefined);

  async function installed(
    workspaceId: string,
  ): Promise<
    { repositories: Installed[] } | { unavailable: NonNullable<Candidates> }
  > {
    if (deps.apps === null) return { unavailable: "no_author_app" };
    const record = await deps.apps.find(workspaceId, "author");
    const credential =
      record === null
        ? undefined
        : (await deps.apps.credentials("author", workspaceId)).find(
            (held) => held.id === record.id,
          );
    if (credential === undefined) return { unavailable: "no_author_app" };
    try {
      const installations = await directory.installations(credential);
      const lists = await Promise.all(
        installations.map(async (installation) =>
          (
            await directory.installationRepositories(
              credential,
              installation.id,
            )
          ).map((repository) => ({
            ...repository,
            account: installation.account,
          })),
        ),
      );
      return { repositories: lists.flat() };
    } catch (error) {
      return {
        unavailable:
          error instanceof GitHubAppCheckError &&
          error.reason === "github_rejected"
            ? "github_rejected"
            : "github_unreachable",
      };
    }
  }

  const rowView = (
    row: CatalogRepositoryRow,
    reachable: Installed[] | null,
  ): CatalogGitHubRepository => ({
    id: row.id,
    github_repository_id: row.github_repository_id,
    full_name: `${row.owner}/${row.name}`,
    url: row.url,
    branch: row.branch,
    source: row.source,
    editable: true,
    version: row.version,
    installed:
      reachable === null
        ? null
        : reachable.some(
            (repository) =>
              repository.id === row.github_repository_id ||
              fullNameOf(repository.owner, repository.name) ===
                fullNameOf(row.owner, row.name),
          ),
    updated_at: row.updated_at,
  });

  const fileView = ([id, repository]: [
    string,
    CatalogRepository,
  ]): CatalogGitHubRepository => {
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
  };

  async function viewOf(
    id: string,
    workspaceId: string,
  ): Promise<CatalogGitHubRepository> {
    const row = (await store.listActive()).find((held) => held.id === id);
    if (row === undefined) throw NOT_FOUND();
    const reachable = await installed(workspaceId);
    return rowView(
      row,
      "repositories" in reachable ? reachable.repositories : null,
    );
  }

  return {
    async list(
      caller: Caller,
      workspaceId: string,
    ): Promise<ListGitHubRepositoriesResponse> {
      await managed(caller, workspaceId);
      const [rows, reachable] = await Promise.all([
        store.listActive(),
        installed(workspaceId),
      ]);
      const repositories =
        "repositories" in reachable ? reachable.repositories : null;
      return {
        repositories: [
          ...rows
            .filter((row) => !reserved.has(row.id))
            .map((row) => rowView(row, repositories)),
          ...fileEntries.map(fileView),
        ],
      };
    },

    async candidates(
      caller: Caller,
      workspaceId: string,
    ): Promise<ListGitHubRepositoryCandidatesResponse> {
      await managed(caller, workspaceId);
      const [rows, reachable] = await Promise.all([
        store.listActive(),
        installed(workspaceId),
      ]);
      if ("unavailable" in reachable) {
        return { candidates: [], unavailable: reachable.unavailable };
      }
      const candidates: GitHubRepositoryCandidate[] = reachable.repositories
        .map((repository) => ({
          github_repository_id: repository.id,
          full_name: `${repository.owner}/${repository.name}`,
          account: repository.account,
          default_branch: repository.defaultBranch,
          private: repository.private,
          catalog_id:
            rows.find(
              (row) =>
                row.github_repository_id === repository.id ||
                fullNameOf(row.owner, row.name) ===
                  fullNameOf(repository.owner, repository.name),
            )?.id ?? null,
        }))
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
      return { candidates, unavailable: null };
    },

    /**
     * `readBody` runs only once the caller is allowed, so a refused caller
     * learns nothing about the request body.
     */
    async add(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PostGitHubRepositoryRequest>,
    ): Promise<GitHubRepositoryWriteResponse> {
      const write = await managed(caller, workspaceId);
      const body = await readBody();
      const reachable = await installed(workspaceId);
      if ("unavailable" in reachable) {
        if (reachable.unavailable === "no_author_app") {
          throw refused(
            "no_author_app",
            "Register the author GitHub App before adding repositories",
          );
        }
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "GitHub could not be reached to list the App's repositories",
          undefined,
          { reason_code: reachable.unavailable },
        );
      }
      // The URL and branch come from GitHub's answer, never from the body.
      const picked = reachable.repositories.find(
        (repository) => repository.id === body.github_repository_id,
      );
      if (picked === undefined) {
        throw refused(
          "not_installed",
          "The author App is not installed on that repository",
        );
      }
      const receiptId = newId();
      const result = await store.add({
        ...write,
        receiptId,
        id:
          body.id === undefined
            ? { base: repositoryIdBase(picked.name) }
            : { exact: body.id },
        reserved,
        githubRepositoryId: picked.id,
        owner: picked.owner,
        name: picked.name,
        url: `https://github.com/${picked.owner}/${picked.name}.git`,
        branch: picked.defaultBranch,
      });
      switch (result.outcome) {
        case "stored":
          await reload();
          return {
            repository: rowView(result.repository, reachable.repositories),
            receipt_id: receiptId,
          };
        case "already_added":
          throw refused(
            "already_added",
            "That repository is in the catalog already",
          );
        case "id_taken":
          throw refused("id_taken", "That catalog id is taken");
        default:
          throw ACTOR_INACTIVE();
      }
    },

    async setBranch(
      caller: Caller,
      workspaceId: string,
      repositoryId: string,
      readBody: () => Promise<PatchGitHubRepositoryRequest>,
    ): Promise<GitHubRepositoryWriteResponse> {
      const write = await managed(caller, workspaceId);
      if (reserved.has(repositoryId)) throw fileOwned();
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
        case "stored":
          await reload();
          return {
            repository: await viewOf(result.repository.id, workspaceId),
            receipt_id: receiptId,
          };
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

    async remove(
      caller: Caller,
      workspaceId: string,
      repositoryId: string,
    ): Promise<DeleteGitHubRepositoryResponse> {
      const write = await managed(caller, workspaceId);
      if (reserved.has(repositoryId)) throw fileOwned();
      const receiptId = newId();
      const result = await store.remove({
        ...write,
        receiptId,
        id: repositoryId,
      });
      switch (result.outcome) {
        case "removed":
          await reload();
          return { receipt_id: receiptId };
        case "in_use":
          throw new SessionServiceError(
            "REPOSITORY_IN_USE",
            "A profile ceiling or an agent's active release still names this repository",
            undefined,
            {
              installation_profiles: result.profiles,
              agents: result.agents,
            },
          );
        case "not_found":
          throw NOT_FOUND();
        default:
          throw ACTOR_INACTIVE();
      }
    },
  };
}

const fileOwned = () =>
  refused(
    "file_repository",
    "The operator's file holds this repository; change it there",
  );

export type GitHubRepositoryService = ReturnType<
  typeof createGitHubRepositoryService
>;

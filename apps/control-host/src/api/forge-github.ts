import type { StructuredLogger } from "@agent-platform/observability";
import {
  type ForgeAccess,
  type ForgeAdapter,
  ForgeCredentialError,
  type ForgeRepository,
  type ForgeResolver,
  GITHUB_API_BASE,
  type GitCredential,
  type RepoRef,
  type SessionCatalog,
} from "@agent-platform/platform";
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";

/**
 * A cached token is re-issued once it has less than this left, so a
 * request the proxy starts with it has time to finish.
 */
export const REFRESH_BEFORE_EXPIRY_MS = 10 * 60_000;

type GitHubCredentials =
  | {
      kind: "app";
      appId: number;
      installationId: number;
      privateKey: string;
    }
  | { kind: "token"; username: string; password: string };

type Logger = Pick<StructuredLogger, "warn">;

/**
 * GitHub, or a GHES host when `apiBase` is its `/api/v3`. An App issues
 * an installation token per repository and access, scoped to that one
 * repository and `contents: <access>`; a PAT is handed back as it is.
 */
export function createGitHubForge(options: {
  apiBase: string;
  credentials: GitHubCredentials;
  now?: () => Date;
  logger?: Logger;
}): ForgeAdapter {
  const apiBase = options.apiBase.replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  const issue = issuer(apiBase, options.credentials, options.logger);
  const cached = new Map<string, GitCredential>();
  const inFlight = new Map<string, Promise<GitCredential>>();

  async function gitCredential(
    repo: RepoRef,
    access: ForgeAccess,
  ): Promise<GitCredential> {
    const key = `${repo.owner}/${repo.name}|${access}`;
    const held = cached.get(key);
    if (
      held !== undefined &&
      (held.expiresAt === undefined ||
        held.expiresAt.getTime() - now().getTime() > REFRESH_BEFORE_EXPIRY_MS)
    ) {
      return held;
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) return await pending;
    const issuing = issue(repo, access).finally(() => inFlight.delete(key));
    inFlight.set(key, issuing);
    const credential = await issuing;
    cached.set(key, credential);
    return credential;
  }

  return {
    kind: "github",
    gitCredential,
    async getRepository(repo): Promise<ForgeRepository> {
      const { password } = await gitCredential(repo, "read");
      let response: Response;
      try {
        response = await fetch(
          `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
          {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `token ${password}`,
            },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch (error) {
        throw failure(options.logger, "repository lookup", error);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(options.logger, "repository lookup", response);
      }
      const body = (await response.json()) as {
        id: number;
        default_branch: string;
        private: boolean;
      };
      return {
        id: body.id,
        defaultBranch: body.default_branch,
        private: body.private,
      };
    },
  };
}

function issuer(
  apiBase: string,
  credentials: GitHubCredentials,
  logger: Logger | undefined,
): (repo: RepoRef, access: ForgeAccess) => Promise<GitCredential> {
  if (credentials.kind === "token") {
    const { username, password } = credentials;
    return async () => ({ username, password });
  }
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    installationId: credentials.installationId,
    request: request.defaults({
      baseUrl: apiBase,
      request: {
        fetch: (url: string, init: RequestInit) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
      },
    }),
  });
  return async (repo, access) => {
    try {
      // The library's own cache knows nothing of the refresh margin, so
      // every issue is a fresh request and the forge keeps the cache.
      const { token, expiresAt } = await auth({
        type: "installation",
        repositoryNames: [repo.name],
        permissions: { contents: access },
        refresh: true,
      });
      return {
        username: "x-access-token",
        password: token,
        expiresAt: new Date(expiresAt),
      };
    } catch (error) {
      throw failure(logger, "installation token request", error);
    }
  };
}

// Only the status and the error's class: an octokit error carries the
// request, whose headers hold the JWT, and a response body may echo a token.
function failure(
  logger: Logger | undefined,
  what: string,
  cause: unknown,
): ForgeCredentialError {
  const status =
    cause instanceof Response
      ? cause.status
      : typeof (cause as { status?: unknown })?.status === "number"
        ? (cause as { status: number }).status
        : undefined;
  const error = cause instanceof Error ? cause.name : "response";
  logger?.warn("GitHub request failed", {
    request: what,
    ...(status === undefined ? {} : { status }),
    error,
  });
  return new ForgeCredentialError(
    `GitHub ${what} failed${status === undefined ? ` (${error})` : ` (${status})`}`,
  );
}

/**
 * The forge behind each catalog repository: a GitHub App repository's own
 * App, and a PAT on github.com. Others (Gitea, GHES with a PAT, bearer,
 * public) have none and keep their static credential.
 */
export function forgesOf(
  catalog: SessionCatalog,
  options: { logger?: Logger; now?: () => Date } = {},
): ForgeResolver {
  const forges = new Map<string, ForgeAdapter>();
  for (const [id, repository] of Object.entries(catalog.repositories)) {
    const { auth } = repository;
    if (auth?.kind === "github_app") {
      forges.set(
        id,
        createGitHubForge({
          ...options,
          apiBase: auth.api_base,
          credentials: {
            kind: "app",
            appId: auth.app_id,
            installationId: auth.installation_id,
            privateKey: auth.value,
          },
        }),
      );
    } else if (
      auth?.kind === "basic" &&
      new URL(repository.url).hostname === "github.com"
    ) {
      forges.set(
        id,
        createGitHubForge({
          ...options,
          apiBase: GITHUB_API_BASE,
          credentials: {
            kind: "token",
            username: auth.username,
            password: auth.value,
          },
        }),
      );
    }
  }
  return (id) => forges.get(id) ?? null;
}

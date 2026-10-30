import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { GitHubAppPermissions, GitHubAppRole } from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type ForgeComment,
  ForgeCredentialError,
  type ForgePullRequest,
  GITHUB_API_BASE,
  type GitCredential,
  type GitHubApi,
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppStore,
  GitHubCallError,
  type GitHubConnection,
  type GitHubConnections,
  GitHubPermissionError,
  type GitHubPermissions,
  type GitHubWorkflowRun,
  type RepoRef,
  type SessionCatalog,
} from "@werft-ai/platform";

/**
 * A cached token is re-issued once it has less than this left, so a
 * request the proxy starts with it has time to finish.
 */
export const REFRESH_BEFORE_EXPIRY_MS = 10 * 60_000;
/** GitHub's limit on a pull request or comment body, in characters. */
const GITHUB_MAX_BODY_LENGTH = 65_536;
export const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMMENT_PAGES = 10;
const COMMENTS_PER_PAGE = 100;

type GitHubCredentials =
  | {
      kind: "app";
      appId: number;
      /** Absent: the installation GitHub reports for each repository. */
      installationId?: number;
      privateKey: string;
    }
  | { kind: "token"; username: string; password: string };

type Logger = Pick<StructuredLogger, "warn">;

const GitHubClient = Octokit.plugin(retry, throttling);
type Client = InstanceType<typeof GitHubClient>;

// Throttling's notification and write pacing waits between POSTs; tests that
// drive many writes turn it off with a group that schedules at once.
const unpaced = {
  key: () => ({
    schedule: (
      _options: unknown,
      task: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => task(...args),
  }),
} as never;

function clientOf(
  apiBase: string,
  logger: Logger | undefined,
  pacing: { retryAfterBaseMs?: number; paced?: boolean },
): Client {
  const onLimit =
    (limit: string) =>
    (
      retryAfter: number,
      options: { method?: string; url?: string },
      _octokit: unknown,
      retryCount: number,
    ) => {
      const retrying =
        retryCount < RATE_LIMIT_RETRIES &&
        retryAfter <= RATE_LIMIT_MAX_WAIT_SECONDS;
      // `url` is the route template: it never carries a token.
      logger?.warn("GitHub rate limit", {
        limit,
        request: `${options.method} ${options.url}`,
        retry_after_seconds: retryAfter,
        retrying,
      });
      return retrying;
    };
  return new GitHubClient({
    baseUrl: apiBase,
    userAgent: "Werft",
    // Octokit's own log would print request errors with their headers.
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: {
      fetch: (url: string, init: RequestInit) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    },
    // 429 is left to throttling, which waits the time GitHub names; this
    // plugin's own backoff would not.
    retry: {
      retries: RATE_LIMIT_RETRIES,
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
      ...(pacing.retryAfterBaseMs === undefined
        ? {}
        : { retryAfterBaseValue: pacing.retryAfterBaseMs }),
    },
    throttle: {
      onRateLimit: onLimit("primary"),
      onSecondaryRateLimit: onLimit("secondary"),
      ...(pacing.retryAfterBaseMs === undefined
        ? {}
        : { retryAfterBaseValue: pacing.retryAfterBaseMs }),
      ...(pacing.paced === false
        ? { write: unpaced, notifications: unpaced }
        : {}),
    },
  });
}

type ConnectionOptions = {
  apiBase: string;
  credentials: GitHubCredentials;
  now?: () => Date;
  logger?: Logger;
  /** Tests only: scale of a retry or rate-limit wait (GitHub's is seconds). */
  retryAfterBaseMs?: number;
  /** Tests only: false drops the pause between writes. */
  paced?: boolean;
};

/**
 * One GitHub connection: an App (or a PAT) on github.com or a GHES host
 * (`apiBase` its `/api/v3`), with its own token cache. An App issues an
 * installation token per repository and permission set, scoped to that one
 * repository; a PAT is used as it is. Only the GitHub gate asks it for a
 * credential; the REST calls take the one the gate issued.
 */
export function createGitHubConnection(
  options: ConnectionOptions,
): GitHubConnection {
  const apiBase = options.apiBase.replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  const { logger, credentials } = options;
  const client = clientOf(apiBase, logger, options);
  const issue = issuer(client, credentials, logger);
  const cached = new Map<string, GitCredential>();
  const inFlight = new Map<string, Promise<GitCredential>>();

  async function credential(
    repo: RepoRef,
    permissions: GitHubPermissions,
  ): Promise<{ credential: GitCredential; fresh: boolean }> {
    const key = `${repo.owner}/${repo.name}|${Object.entries(permissions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, level]) => `${name}:${level}`)
      .join(",")}`;
    const held = cached.get(key);
    if (
      held !== undefined &&
      (held.expiresAt === undefined ||
        held.expiresAt.getTime() - now().getTime() > REFRESH_BEFORE_EXPIRY_MS)
    ) {
      return { credential: held, fresh: false };
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      return { credential: await pending, fresh: false };
    }
    const issuing = issue(repo, permissions).finally(() =>
      inFlight.delete(key),
    );
    inFlight.set(key, issuing);
    const issued = await issuing;
    cached.set(key, issued);
    // A PAT is not issued: nothing new to account for.
    return { credential: issued, fresh: credentials.kind === "app" };
  }

  const queues = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
    const turn = (queues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(run);
    queues.set(key, turn);
    void turn
      .finally(() => {
        if (queues.get(key) === turn) queues.delete(key);
      })
      .catch(() => undefined);
    return turn;
  }

  // Anyone can paste a marker into a comment, so only one this credential
  // wrote is the platform's: the App's own, or the PAT owner's.
  let tokenUser: Promise<number> | undefined;
  async function writtenByUs(
    comment: {
      user?: { id: number | bigint } | null | undefined;
      performed_via_github_app?: { id: number | bigint } | null | undefined;
    },
    headers: { authorization: string },
  ): Promise<boolean> {
    if (credentials.kind === "app") {
      const app = comment.performed_via_github_app;
      return app != null && Number(app.id) === credentials.appId;
    }
    tokenUser ??= client
      .request("GET /user", { headers })
      .then(({ data }) => Number(data.id))
      .catch((error: unknown) => {
        tokenUser = undefined;
        throw error;
      });
    const user = comment.user;
    return user != null && Number(user.id) === (await tokenUser);
  }

  function api(repo: RepoRef, issued: GitCredential): GitHubApi {
    const headers = { authorization: `token ${issued.password}` };
    const target = { owner: repo.owner, repo: repo.name };
    async function call<T>(what: string, send: () => Promise<T>): Promise<T> {
      try {
        return await send();
      } catch (error) {
        throw failure(logger, what, error);
      }
    }
    // The work added with the gate: its errors keep GitHub's status and
    // request id only, never the body, which may echo what was sent.
    async function quiet<T>(what: string, send: () => Promise<T>): Promise<T> {
      try {
        return await send();
      } catch (error) {
        const status = statusOf(error) ?? null;
        const requestId = requestIdOf(error);
        logger?.warn("GitHub request failed", {
          request: what,
          ...(status === null ? {} : { status }),
          error: error instanceof Error ? error.name : "response",
          ...(requestId === null ? {} : { github_request_id: requestId }),
        });
        throw new GitHubCallError(what, status, requestId);
      }
    }
    async function findPullRequestForBranch(
      branch: string,
    ): Promise<ForgePullRequest | null> {
      const { data } = await call("pull request lookup", () =>
        client.request("GET /repos/{owner}/{repo}/pulls", {
          ...target,
          head: `${repo.owner}:${branch}`,
          state: "open",
          sort: "created",
          direction: "desc",
          per_page: 1,
          headers,
        }),
      );
      const [found] = data;
      return found === undefined ? null : pullRequestOf(found);
    }
    // Routes octokit's types do not know yet (return_run_details).
    const request = client.request as unknown as (
      route: string,
      parameters: Record<string, unknown>,
    ) => Promise<{ status: number; data: unknown }>;

    return {
      maxBodyLength: GITHUB_MAX_BODY_LENGTH,
      async getRepository() {
        const { data } = await call("repository lookup", () =>
          client.request("GET /repos/{owner}/{repo}", { ...target, headers }),
        );
        return {
          id: Number(data.id),
          defaultBranch: data.default_branch,
          private: data.private,
        };
      },
      findPullRequestForBranch,
      async createPullRequest(input) {
        try {
          const { data } = await client.request(
            "POST /repos/{owner}/{repo}/pulls",
            {
              ...target,
              head: input.head,
              base: input.base,
              title: input.title,
              body: input.body,
              headers,
            },
          );
          return pullRequestOf(data);
        } catch (error) {
          // 422: an open pull request for this head already exists, as when
          // two callers race; answer that one.
          if (statusOf(error) === 422) {
            const open = await findPullRequestForBranch(input.head);
            if (open?.state === "open") return open;
          }
          throw failure(logger, "pull request create", error);
        }
      },
      async upsertComment(number, marker, body): Promise<ForgeComment> {
        const text = `${body}\n\n${marker}`;
        // Two first comments for one marker would both find none and both
        // post; one at a time per marker in this process.
        return await oneAtATime(
          `${repo.owner}/${repo.name}#${number}|${marker}`,
          () =>
            call("pull request comment", async () => {
              let searched = false;
              for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
                const { data } = await client.request(
                  "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
                  {
                    ...target,
                    issue_number: number,
                    per_page: COMMENTS_PER_PAGE,
                    page,
                    headers,
                  },
                );
                let marked: (typeof data)[number] | undefined;
                for (const comment of data) {
                  if (
                    comment.body?.includes(marker) &&
                    (await writtenByUs(comment, headers))
                  ) {
                    marked = comment;
                    break;
                  }
                }
                if (marked !== undefined) {
                  const { data: edited } = await client.request(
                    "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
                    {
                      ...target,
                      comment_id: Number(marked.id),
                      body: text,
                      headers,
                    },
                  );
                  return {
                    id: Number(edited.id),
                    url: edited.html_url,
                    created: false,
                  };
                }
                if (data.length < COMMENTS_PER_PAGE) {
                  searched = true;
                  break;
                }
              }
              // Past the pages read the marked comment may still exist; a new
              // one would duplicate it.
              if (!searched) {
                throw new ForgeCredentialError(
                  `GitHub pull request comment failed (more than ${MAX_COMMENT_PAGES * COMMENTS_PER_PAGE} comments)`,
                );
              }
              const { data: posted } = await client.request(
                "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
                {
                  ...target,
                  issue_number: number,
                  body: text,
                  headers,
                  // GitHub may have stored a comment that answered 5xx; a
                  // blind retry would post it twice.
                  request: { retries: 0 },
                },
              );
              return {
                id: Number(posted.id),
                url: posted.html_url,
                created: true,
              };
            }),
        );
      },
      async dispatchWorkflow(input) {
        const { status, data } = await quiet("workflow dispatch", () =>
          request(
            "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
            {
              ...target,
              workflow_id: input.workflow,
              // A branch, never a tag of the same name.
              ref: `refs/heads/${input.ref}`,
              inputs: input.inputs,
              return_run_details: true,
              headers,
              // A dispatch GitHub took and answered 5xx would run twice.
              request: { retries: 0 },
            },
          ),
        );
        const run = data as { workflow_run_id?: unknown; html_url?: unknown };
        return status === 200 &&
          typeof run?.workflow_run_id === "number" &&
          typeof run.html_url === "string"
          ? { id: run.workflow_run_id, html_url: run.html_url }
          : null;
      },
      async getWorkflowRun(runId): Promise<GitHubWorkflowRun> {
        const { data } = await quiet("workflow run lookup", () =>
          client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
            ...target,
            run_id: runId,
            headers,
          }),
        );
        return {
          id: Number(data.id),
          path: data.path,
          head_branch: data.head_branch ?? null,
          status: data.status ?? null,
          conclusion: data.conclusion ?? null,
          html_url: data.html_url,
        };
      },
      async rerunWorkflow(runId, failedOnly) {
        await quiet("workflow rerun", () =>
          request(
            failedOnly
              ? "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
              : "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
            { ...target, run_id: runId, headers, request: { retries: 0 } },
          ),
        );
      },
      async submitReview(input) {
        const { data } = await quiet("pull request review", () =>
          client.request(
            "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            {
              ...target,
              pull_number: input.number,
              commit_id: input.commitId,
              event: input.event,
              ...(input.body === undefined ? {} : { body: input.body }),
              headers,
              // A review GitHub stored and answered 5xx would post twice.
              request: { retries: 0 },
            },
          ),
        );
        return { id: Number(data.id), html_url: data.html_url };
      },
    };
  }

  return {
    kind: credentials.kind === "app" ? "app" : "pat",
    githubCom: apiBase === GITHUB_API_BASE,
    appId: credentials.kind === "app" ? credentials.appId : null,
    credential,
    installed: installedCheck(client, credentials),
    api,
  };
}

function installedCheck(
  client: Client,
  credentials: GitHubCredentials,
): GitHubConnection["installed"] {
  if (credentials.kind !== "app") return async () => null;
  if (credentials.installationId !== undefined) return async () => true;
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    request: client.request,
  });
  return async (repo) => (await installationFor(client, auth, repo)) !== null;
}

function pullRequestOf(data: {
  number: number;
  html_url: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
}): ForgePullRequest {
  return {
    number: data.number,
    url: data.html_url,
    state: data.state === "open" ? "open" : "closed",
    head: data.head.ref,
    base: data.base.ref,
  };
}

function issuer(
  client: Client,
  credentials: GitHubCredentials,
  logger: Logger | undefined,
): (repo: RepoRef, permissions: GitHubPermissions) => Promise<GitCredential> {
  if (credentials.kind === "token") {
    const { username, password } = credentials;
    return async () => ({ username, password });
  }
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    request: client.request,
  });
  const fixed = credentials.installationId;
  const found = new Map<string, number>();
  async function installationOf(repo: RepoRef): Promise<number> {
    if (fixed !== undefined) return fixed;
    const key = `${repo.owner}/${repo.name}`;
    const held = found.get(key);
    if (held !== undefined) return held;
    const id = (await installationFor(client, auth, repo))?.id ?? null;
    if (id === null) {
      throw new ForgeCredentialError(
        `GitHub App is not installed on ${repo.owner}/${repo.name}`,
      );
    }
    found.set(key, id);
    return id;
  }
  return async (repo, permissions) => {
    try {
      const installationId = await installationOf(repo);
      // The library's own cache knows nothing of the refresh margin, so
      // every issue is a fresh request and the connection keeps the cache.
      const { token, expiresAt } = await auth({
        type: "installation",
        installationId,
        repositoryNames: [repo.name],
        permissions,
        refresh: true,
      }).catch((error: unknown) => {
        // Uninstalled and installed again: the next issue looks it up anew.
        found.delete(`${repo.owner}/${repo.name}`);
        throw error;
      });
      return {
        username: "x-access-token",
        password: token,
        expiresAt: new Date(expiresAt),
      };
    } catch (error) {
      // GitHub refuses a permission the installation was not granted with
      // 422; that is the App's settings, not GitHub failing.
      if (statusOf(error) === 422) {
        failure(logger, "installation token request", error);
        throw new GitHubPermissionError(
          "The installation does not grant the permissions asked",
        );
      }
      throw failure(logger, "installation token request", error);
    }
  };
}

type AppAuth = ReturnType<typeof createAppAuth>;

async function appHeaders(auth: AppAuth) {
  const { token } = await auth({ type: "app" });
  return { authorization: `bearer ${token}` };
}

const statusOf = (error: unknown): number | undefined =>
  typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : undefined;

const requestIdOf = (error: unknown): string | null => {
  const id = (error as { response?: { headers?: Record<string, unknown> } })
    ?.response?.headers?.["x-github-request-id"];
  return typeof id === "string" ? id.slice(0, 64) : null;
};

/**
 * The installation that covers `repo` and what it grants, or null when the
 * App has none there.
 */
async function installationFor(
  client: Client,
  auth: AppAuth,
  repo: RepoRef,
): Promise<{ id: number; permissions: GitHubAppPermissions } | null> {
  try {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner: repo.owner, repo: repo.name, headers: await appHeaders(auth) },
    );
    return {
      id: Number(data.id),
      permissions: permissionsOf(data.permissions),
    };
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

const MAX_INSTALLATION_PAGES = 10;
const INSTALLATIONS_PER_PAGE = 100;

/**
 * GitHub's answers about an App, asked with its JWT. A 401, 403 or 404 means
 * GitHub refused the App itself (a wrong id, a key it does not know, a
 * deleted App); anything else is GitHub not answering.
 */
export function createGitHubAppDirectory(
  options: { logger?: Logger; retryAfterBaseMs?: number } = {},
): GitHubAppDirectory {
  const { logger } = options;
  const clients = new Map<string, Client>();
  const clientFor = (apiBase: string) => {
    const base = apiBase.replace(/\/+$/, "");
    let client = clients.get(base);
    if (client === undefined) {
      client = clientOf(base, logger, options);
      clients.set(base, client);
    }
    return client;
  };
  async function asking<T>(
    what: string,
    app: { appId: number; apiBase: string; privateKey: string },
    ask: (client: Client, auth: AppAuth) => Promise<T>,
  ): Promise<T> {
    const client = clientFor(app.apiBase);
    try {
      return await ask(
        client,
        createAppAuth({
          appId: app.appId,
          privateKey: app.privateKey,
          request: client.request,
        }),
      );
    } catch (error) {
      const status = statusOf(error);
      failure(logger, what, error);
      // A 403 is also a rate limit or an IP allow list, which says nothing
      // about the key.
      throw new GitHubAppCheckError(
        status === 401 || status === 404
          ? "github_rejected"
          : "github_unreachable",
      );
    }
  }
  return {
    describe: (app) =>
      asking("App lookup", app, async (client, auth) => {
        const { data } = await client.request("GET /app", {
          headers: await appHeaders(auth),
        });
        if (data === null) throw new Error("GitHub answered no App");
        return {
          appId: Number(data.id),
          slug: data.slug ?? String(data.id),
          name: data.name,
          htmlUrl: data.html_url,
          permissions: permissionsOf(data.permissions),
        };
      }),
    installations: (app) =>
      asking("App installations", app, async (client, auth) => {
        const all: GitHubAppInstallationView[] = [];
        for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
          const { data } = await client.request("GET /app/installations", {
            per_page: INSTALLATIONS_PER_PAGE,
            page,
            headers: await appHeaders(auth),
          });
          for (const installation of data) {
            // A user or an organization has a login, an enterprise a slug.
            const account = installation.account as {
              login?: string;
              slug?: string;
            } | null;
            all.push({
              id: Number(installation.id),
              account:
                account?.login ?? account?.slug ?? String(installation.id),
              repositorySelection: installation.repository_selection,
              htmlUrl: installation.html_url ?? null,
            });
          }
          if (data.length < INSTALLATIONS_PER_PAGE) break;
        }
        return all;
      }),
    installationFor: (app, repo) =>
      asking("App installation lookup", app, (client, auth) =>
        installationFor(client, auth, repo),
      ),
  };
}

/** `GET /app`'s permissions, keeping only the levels GitHub names. */
function permissionsOf(
  raw: unknown,
): Record<string, "read" | "write" | "admin"> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, "read" | "write" | "admin"] =>
        entry[1] === "read" || entry[1] === "write" || entry[1] === "admin",
    ),
  );
}

/**
 * The connection of the console's App for `role`, rebuilt (and its
 * token cache dropped) when the App or its key changes. `refresh` reads the
 * store; until the first read, and with no App registered, there is none.
 */
export function createRegisteredGitHubConnection(
  options: {
    store: Pick<GitHubAppStore, "credentials"> | null;
    role: GitHubAppRole;
  } & Pick<ConnectionOptions, "logger" | "now" | "retryAfterBaseMs" | "paced">,
) {
  const { store, role, ...connectionOptions } = options;
  let current: { version: string; connection: GitHubConnection } | null = null;
  // Reads run one after another, so a read that started before a change
  // cannot land after the read that saw it.
  let queue: Promise<void> = Promise.resolve();
  const read = async (): Promise<void> => {
    if (store === null) return;
    // Bootstrap makes the one workspace, so there is at most one App a role.
    const [app] = await store.credentials(role);
    if (app === undefined) {
      current = null;
      return;
    }
    const version = `${app.id}|${app.updatedAt.toISOString()}`;
    if (current?.version === version) return;
    current = {
      version,
      connection: createGitHubConnection({
        ...connectionOptions,
        apiBase: app.apiBase,
        credentials: {
          kind: "app",
          appId: app.appId,
          privateKey: app.privateKey,
        },
      }),
    };
  };
  return {
    connection: (): GitHubConnection | null => current?.connection ?? null,
    refresh(): Promise<void> {
      const next = queue.then(read);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

// The status, the error's class and GitHub's reason (githubReason), never the
// error itself: an octokit error carries the request, whose headers hold the
// JWT or the token.
function failure(
  logger: Logger | undefined,
  what: string,
  cause: unknown,
): ForgeCredentialError {
  if (cause instanceof ForgeCredentialError) return cause;
  const status = statusOf(cause);
  const error = cause instanceof Error ? cause.name : "response";
  logger?.warn("GitHub request failed", {
    request: what,
    ...(status === undefined ? {} : { status }),
    error,
    ...githubReason(cause),
  });
  return new ForgeCredentialError(
    `GitHub ${what} failed${status === undefined ? ` (${error})` : ` (${status})`}`,
  );
}

const REASON_MAX_LENGTH = 200;

/**
 * GitHub's own words for a refused call (a 422 says which field and why).
 * Only the response body is read, and of it only `message` and `errors`, cut
 * short; GitHub does not echo the request's credential there. The field
 * names avoid "message": the log redaction drops keys that look like one.
 * Not for work whose request carries caller values (dispatch inputs).
 */
function githubReason(cause: unknown): {
  github_reason?: string;
  github_errors?: string[];
} {
  const data = (cause as { response?: { data?: unknown } })?.response?.data;
  if (typeof data !== "object" || data === null) return {};
  const cut = (text: string) => text.slice(0, REASON_MAX_LENGTH);
  const { message, errors } = data as { message?: unknown; errors?: unknown };
  const reasons = Array.isArray(errors)
    ? errors.slice(0, 5).map((entry) =>
        cut(
          typeof entry === "string"
            ? entry
            : ["resource", "field", "code", "message"]
                .map((key) => (entry as Record<string, unknown>)?.[key])
                .filter((part) => typeof part === "string")
                .join(" "),
        ),
      )
    : [];
  const kept = reasons.filter((reason) => reason !== "");
  return {
    ...(typeof message === "string" ? { github_reason: cut(message) } : {}),
    ...(kept.length > 0 ? { github_errors: kept } : {}),
  };
}

/**
 * The connection behind each catalog repository: a GitHub App repository's
 * own App (one connection each), the console's App for `{ kind: github_app }`,
 * and a PAT on github.com. Others (Gitea, GHES with a PAT, bearer, public)
 * have none and keep their static credential. Only `{ kind: github_app }`
 * repositories have a reviewer: the console's reviewer App.
 */
export function connectionsOf(
  catalog: SessionCatalog,
  options: Pick<
    ConnectionOptions,
    "logger" | "now" | "retryAfterBaseMs" | "paced"
  > & {
    /** The console's Apps, for repositories written as `{ kind: github_app }`. */
    registered?: (role: GitHubAppRole) => GitHubConnection | null;
  } = {},
): GitHubConnections {
  const { registered, ...connectionOptions } = options;
  const connections = new Map<string, GitHubConnection>();
  const usesRegistered = new Set<string>();
  for (const [id, repository] of Object.entries(catalog.repositories)) {
    const { auth } = repository;
    if (auth?.kind === "github_app" && "registered" in auth) {
      usesRegistered.add(id);
    } else if (auth?.kind === "github_app") {
      connections.set(
        id,
        createGitHubConnection({
          ...connectionOptions,
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
      connections.set(
        id,
        createGitHubConnection({
          ...connectionOptions,
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
  return (id, role) => {
    if (usesRegistered.has(id)) return registered?.(role) ?? null;
    return role === "author" ? (connections.get(id) ?? null) : null;
  };
}

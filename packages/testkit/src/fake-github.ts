import { createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServedRepository,
  runTestGit,
  serveGitHttp,
} from "./git-http.ts";

/** One `POST /app/installations/:id/access_tokens` as the fake read it. */
export type FakeGitHubTokenRequest = {
  at: string;
  installationId: number;
  /** The request body as sent: `repositories`, `permissions`. */
  body: unknown;
  /** The verified JWT's claims; absent when it did not verify. */
  jwt?: { iss: string; iat: number; exp: number };
  status: number;
};

/** One git request, with which issued token (by number, not value) it carried. */
export type FakeGitHubGitRequest = {
  at: string;
  method: string;
  path: string;
  /** True for a push (receive-pack), whether or not it was taken. */
  push: boolean;
  /** 1-based index of the issued token it carried, or null. */
  token: number | null;
  status: number;
};

/** One REST call other than a token issue, with the body a write sent. */
export type FakeGitHubApiRequest = {
  at: string;
  method: string;
  path: string;
  /** 1-based index of the issued token it carried, or null. */
  token: number | null;
  /** The JSON body of a POST or PATCH, as received. */
  body?: unknown;
  status: number;
};

export type FakeGitHubPullRequest = {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  /** The App whose installation token opened it. */
  author_app_id: number;
  html_url: string;
};

export type FakeGitHubComment = {
  id: number;
  body: string;
  html_url: string;
  user: { id: number; login: string };
  /** Set on a comment written with the App's installation token. */
  performed_via_github_app: { id: number } | null;
};

/** A pull request review, with the App whose token submitted it. */
export type FakeGitHubReview = {
  id: number;
  pull_number: number;
  commit_id: string;
  event: string;
  body: string | null;
  app_id: number;
};

/** A workflow run: dispatched through the API, or added as if by a push. */
export type FakeGitHubWorkflowRun = {
  id: number;
  path: string;
  head_branch: string;
  event: string;
  status: "queued" | "completed";
  conclusion: "success" | "failure" | null;
  html_url: string;
  /** The dispatch's inputs, as received. */
  inputs: Record<string, unknown> | null;
  reruns: Array<{ failedOnly: boolean }>;
};

export type FakeGitHubPermissions = Record<string, "read" | "write">;

export type FakeGitHub = {
  /** `http://<host>:<port>`: both the API base and the git origin. */
  readonly origin: string;
  readonly port: number;
  readonly tokenRequests: FakeGitHubTokenRequest[];
  readonly gitRequests: FakeGitHubGitRequest[];
  readonly apiRequests: FakeGitHubApiRequest[];
  /** While on, the token endpoint answers 500. */
  failTokens(on: boolean): void;
  /**
   * What the installation grants (and `GET /app` reports). A token asking
   * for more answers 422, as GitHub does. Unset grants whatever is asked.
   */
  setPermissions(permissions: FakeGitHubPermissions | undefined): void;
  /** While on, a workflow dispatch answers 422 with its inputs echoed. */
  failDispatches(on: boolean): void;
  /** A run GitHub started without the API (a push); returns its id. */
  addWorkflowRun(
    owner: string,
    name: string,
    run: { path: string; head_branch: string; event?: string },
  ): number;
  workflowRuns(owner: string, name: string): FakeGitHubWorkflowRun[];
  /** A bare repository served at `/<owner>/<name>.git` with one commit. */
  createRepository(
    owner: string,
    name: string,
    files: Record<string, string>,
    options?: { branch?: string; private?: boolean },
  ): Promise<void>;
  /** Every branch and tag of a served repository, ref → commit. */
  refs(owner: string, name: string): Promise<Record<string, string>>;
  /**
   * Points `branch` at a new commit with no parent, so that nothing pushed
   * from the repository's own history fast-forwards it. Returns the commit.
   */
  writeUnrelatedCommit(
    owner: string,
    name: string,
    branch: string,
  ): Promise<string>;
  /**
   * The next `count` REST calls (not token issues) answer a rate limit:
   * `secondary` is a 403 with `retry-after`, `primary` a 429 with
   * `x-ratelimit-remaining: 0` and `x-ratelimit-reset`.
   */
  rateLimitNext(
    count: number,
    limit: "primary" | "secondary",
    retryAfterSeconds?: number,
  ): void;
  pullRequests(owner: string, name: string): FakeGitHubPullRequest[];
  comments(owner: string, name: string, number: number): FakeGitHubComment[];
  reviews(owner: string, name: string, pullNumber: number): FakeGitHubReview[];
  /** A comment by a person, not the App, on a pull request. */
  addComment(
    owner: string,
    name: string,
    number: number,
    body: string,
  ): FakeGitHubComment;
  /** What `GET /repos` and the git `HEAD` both report as the default. */
  setDefaultBranch(owner: string, name: string, branch: string): Promise<void>;
  stop(): Promise<void>;
};

export type FakeGitHubOptions = {
  appId: number;
  /** The App's public key (PEM); the JWT must verify against it. */
  publicKey: string;
  hostname?: string;
  port?: number;
  /** Lifetime of an issued token; GitHub's is an hour. */
  tokenTtlSeconds?: number;
  now?: () => Date;
  /** The one installation `GET /app/installations` and lookups report. */
  installationId?: number;
  slug?: string;
  /** See `setPermissions`. */
  permissions?: FakeGitHubPermissions;
  /**
   * Another App on the same GitHub (a reviewer App): its own key and
   * installation. GitHub refuses its approval of a pull request it opened.
   */
  secondApp?: {
    appId: number;
    publicKey: string;
    installationId: number;
    slug?: string;
    /** What its installation grants; unset grants whatever is asked. */
    permissions?: FakeGitHubPermissions;
    /** `owner/name` it is installed on; unset: every served repository. */
    installedOn?: string[];
  };
};

const LEVEL = { read: 1, write: 2 } as const;
const APP_PERMISSIONS_DEFAULT: FakeGitHubPermissions = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
};

type Issued = {
  appId: number;
  index: number;
  installationId: number;
  /** Null when the request named no repositories: every one is reachable. */
  repositories: string[] | null;
  permissions: Record<string, string>;
  expiresAt: Date;
};

type Served = {
  id: number;
  defaultBranch: string;
  private: boolean;
  pulls: FakeGitHubPullRequest[];
  comments: Map<number, FakeGitHubComment[]>;
  runs: FakeGitHubWorkflowRun[];
  reviews: FakeGitHubReview[];
};

/**
 * A GitHub App's side of GitHub for tests and the local stack: the
 * installation token endpoint (RS256 JWT checked against the App's public
 * key), `GET /repos/:owner/:name`, the pull request and issue comment
 * calls a forge adapter makes (permission-checked as GitHub does), and git
 * smart HTTP that takes only an
 * unexpired installation token scoped to the repository. API paths are
 * also served under `/api/v3`, as on GHES. A push (receive-pack) needs a
 * token whose permissions say `contents: write`; a read token gets a 403,
 * as on GitHub.
 */
const APP_BOT_USER_ID = 9000;

export async function startFakeGitHub(
  options: FakeGitHubOptions,
): Promise<FakeGitHub> {
  const root = await mkdtemp(join(tmpdir(), "testkit-fake-github-"));
  const publicKey = createPublicKey(options.publicKey);
  const second = options.secondApp;
  const secondKey = second ? createPublicKey(second.publicKey) : undefined;
  const now = options.now ?? (() => new Date());
  const ttlMs = (options.tokenTtlSeconds ?? 3600) * 1000;
  const tokenRequests: FakeGitHubTokenRequest[] = [];
  const gitRequests: FakeGitHubGitRequest[] = [];
  const issued = new Map<string, Issued>();
  const served = new Map<string, Served>();
  let failing = false;
  let failingDispatches = false;
  let granted = options.permissions;
  let nextRunId = 7_000_000_000;

  function verifiedJwt(authorization: string | null) {
    const jwt = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
    const [head, body, signature] = jwt?.split(".") ?? [];
    if (!head || !body || !signature) return undefined;
    const signedBy = [publicKey, secondKey].findIndex(
      (key) =>
        key !== undefined &&
        verify(
          "RSA-SHA256",
          Buffer.from(`${head}.${body}`),
          key,
          Buffer.from(signature, "base64url"),
        ),
    );
    if (signedBy === -1) return undefined;
    const appId = signedBy === 0 ? options.appId : second?.appId;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const seconds = Math.floor(now().getTime() / 1000);
    if (
      String(claims.iss) !== String(appId) ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      claims.iat > seconds + 60 ||
      claims.exp <= seconds ||
      claims.exp - claims.iat > 600
    ) {
      return undefined;
    }
    return { iss: String(claims.iss), iat: claims.iat, exp: claims.exp };
  }

  function installationToken(
    authorization: string | null,
    scheme: "token" | "basic",
  ): [string, Issued] | undefined {
    let token: string | undefined;
    if (scheme === "basic") {
      const login = /^Basic (.+)$/i.exec(authorization ?? "")?.[1];
      const [user, password] = Buffer.from(login ?? "", "base64")
        .toString()
        .split(":");
      if (user === "x-access-token") token = password;
    } else {
      token = /^(?:token|Bearer) (.+)$/i.exec(authorization ?? "")?.[1];
    }
    const found = token === undefined ? undefined : issued.get(token);
    if (!token || !found || found.expiresAt <= now()) return undefined;
    return [token, found];
  }

  async function accessTokens(request: Request, installationId: number) {
    const body: unknown = await request.json().catch(() => null);
    const jwt = verifiedJwt(request.headers.get("authorization"));
    const record = (status: number) => {
      tokenRequests.push({
        at: now().toISOString(),
        installationId,
        body,
        ...(jwt === undefined ? {} : { jwt }),
        status,
      });
    };
    if (failing) {
      record(500);
      return Response.json({ message: "Server Error" }, { status: 500 });
    }
    if (jwt === undefined) {
      record(401);
      return Response.json(
        { message: "A JSON web token could not be decoded" },
        { status: 401 },
      );
    }
    const appId = Number(jwt.iss);
    const ownInstallation =
      appId === second?.appId
        ? installationId === second.installationId
        : installationId !== second?.installationId;
    if (!ownInstallation) {
      record(404);
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const grants = appId === options.appId ? granted : second?.permissions;
    const asked = body as {
      repositories?: string[];
      permissions?: Record<string, string>;
    } | null;
    const ungranted = Object.entries(asked?.permissions ?? {}).some(
      ([permission, level]) => {
        if (grants === undefined) return false;
        const held = grants[permission];
        return (
          held === undefined ||
          (LEVEL[level as keyof typeof LEVEL] ?? 3) > LEVEL[held]
        );
      },
    );
    if (ungranted) {
      record(422);
      return Response.json(
        {
          message:
            "The permissions requested are not granted to this installation.",
        },
        { status: 422 },
      );
    }
    const token = `ghs_${randomBytes(18).toString("base64url")}`;
    const expiresAt = new Date(now().getTime() + ttlMs);
    issued.set(token, {
      appId,
      index: issued.size + 1,
      installationId,
      repositories: asked?.repositories ?? null,
      permissions: asked?.permissions ?? { contents: "read", metadata: "read" },
      expiresAt,
    });
    record(201);
    const repositories = (asked?.repositories ?? []).flatMap((name) =>
      [...served.entries()]
        .filter(([key]) => key.endsWith(`/${name}`))
        .map(([key, repo]) => ({ id: repo.id, name, full_name: key })),
    );
    return Response.json(
      {
        token,
        expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        permissions: asked?.permissions ?? { contents: "read" },
        repository_selection: "selected",
        ...(asked?.repositories === undefined ? {} : { repositories }),
      },
      { status: 201 },
    );
  }

  function installedOn(appId: number, repository: string): boolean {
    return (
      appId !== second?.appId ||
      second.installedOn === undefined ||
      second.installedOn.includes(repository)
    );
  }

  function reaches(grant: Issued, owner: string, name: string): boolean {
    return (
      served.has(`${owner}/${name}`) &&
      installedOn(grant.appId, `${owner}/${name}`) &&
      (grant.repositories === null || grant.repositories.includes(name))
    );
  }

  const apiRequests: FakeGitHubApiRequest[] = [];
  let limited: {
    count: number;
    limit: "primary" | "secondary";
    retryAfter: number;
  } = { count: 0, limit: "secondary", retryAfter: 1 };
  let nextCommentId = 5000;
  let nextReviewId = 8000;
  function commentOn(
    thread: FakeGitHubComment[],
    htmlBase: string,
    number: number,
    body: string,
    by: Pick<FakeGitHubComment, "user" | "performed_via_github_app">,
  ): FakeGitHubComment {
    nextCommentId += 1;
    const comment = {
      id: nextCommentId,
      body,
      html_url: `${htmlBase}/pull/${number}#issuecomment-${nextCommentId}`,
      ...by,
    };
    thread.push(comment);
    return comment;
  }
  const origin = () =>
    `http://${options.hostname ?? "127.0.0.1"}:${server.port}`;

  function rateLimited(): Response | undefined {
    if (limited.count <= 0) return undefined;
    limited.count -= 1;
    if (limited.limit === "secondary") {
      return Response.json(
        {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        },
        { status: 403, headers: { "retry-after": String(limited.retryAfter) } },
      );
    }
    const reset = Math.ceil(now().getTime() / 1000) + limited.retryAfter;
    return Response.json(
      { message: "API rate limit exceeded" },
      {
        status: 429,
        headers: {
          "x-ratelimit-limit": "5000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        },
      },
    );
  }

  // The REST calls a forge adapter makes, with GitHub's permission rules:
  // a pull request or its comments need `pull_requests` (write to change
  // anything) or, for comments, `issues`.
  async function rest(
    method: string,
    path: string,
    url: URL,
    carried: [string, Issued] | undefined,
    body: unknown,
  ): Promise<Response> {
    const notFound = () =>
      Response.json({ message: "Not Found" }, { status: 404 });
    const forbidden = () =>
      Response.json(
        { message: "Resource not accessible by integration" },
        { status: 403 },
      );
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    const [owner, name, rest = ""] = [match?.[1], match?.[2], match?.[3]];
    const found = owner && name ? served.get(`${owner}/${name}`) : undefined;
    const grant = carried?.[1];
    if (!owner || !name || !found || !grant || !reaches(grant, owner, name)) {
      return notFound();
    }
    const limit = rateLimited();
    if (limit) return limit;
    const can = (permission: string, level: "read" | "write") =>
      grant.permissions[permission] === "write" ||
      (level === "read" && grant.permissions[permission] === "read");
    const htmlBase = `${origin()}/${owner}/${name}`;
    const input = (body ?? {}) as Record<string, unknown>;

    if (rest === "" && method === "GET") {
      return Response.json({
        id: found.id,
        name,
        full_name: `${owner}/${name}`,
        default_branch: found.defaultBranch,
        private: found.private,
      });
    }
    const pullJson = (pull: FakeGitHubPullRequest) => ({
      number: pull.number,
      html_url: pull.html_url,
      state: pull.state,
      title: pull.title,
      body: pull.body,
      head: { ref: pull.head, label: `${owner}:${pull.head}` },
      base: { ref: pull.base },
    });
    if (rest === "/pulls" && method === "GET") {
      if (!can("pull_requests", "read")) return forbidden();
      const head = url.searchParams.get("head");
      const state = url.searchParams.get("state") ?? "open";
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const listed = found.pulls
        .filter((pull) => head === null || `${owner}:${pull.head}` === head)
        .filter((pull) => state === "all" || pull.state === state)
        .sort((a, b) => b.number - a.number)
        .slice(0, perPage);
      return Response.json(listed.map(pullJson));
    }
    if (rest === "/pulls" && method === "POST") {
      if (!can("pull_requests", "write")) return forbidden();
      // github.com answers a token that cannot read the branches this way
      // (measured 2026-10-29 with an App token narrowed to pull_requests).
      if (!can("contents", "read")) {
        return Response.json(
          {
            message: "Validation Failed",
            errors: [
              {
                resource: "PullRequest",
                code: "custom",
                message: "not all refs are readable",
              },
            ],
          },
          { status: 422 },
        );
      }
      const head = String(input.head ?? "");
      const base = String(input.base ?? "");
      const refs = await runTestGit(
        ["for-each-ref", "--format=%(refname)"],
        join(root, owner, `${name}.git`),
      );
      const branches = refs.split("\n");
      if (
        !branches.includes(`refs/heads/${head}`) ||
        !branches.includes(`refs/heads/${base}`)
      ) {
        return Response.json(
          { message: "Validation Failed", errors: [{ field: "head" }] },
          { status: 422 },
        );
      }
      if (
        found.pulls.some((pull) => pull.head === head && pull.state === "open")
      ) {
        return Response.json(
          {
            message: "Validation Failed",
            errors: [
              {
                message: `A pull request already exists for ${owner}:${head}.`,
              },
            ],
          },
          { status: 422 },
        );
      }
      const number = found.pulls.length + 1;
      const pull: FakeGitHubPullRequest = {
        number,
        head,
        base,
        title: String(input.title ?? ""),
        body: String(input.body ?? ""),
        state: "open",
        author_app_id: grant.appId,
        html_url: `${htmlBase}/pull/${number}`,
      };
      found.pulls.push(pull);
      found.comments.set(number, []);
      return Response.json(pullJson(pull), { status: 201 });
    }
    const single = /^\/pulls\/(\d+)$/.exec(rest);
    if (single?.[1] && (method === "GET" || method === "PATCH")) {
      const pull = found.pulls.find(
        (entry) => entry.number === Number(single[1]),
      );
      if (pull === undefined) return notFound();
      if (!can("pull_requests", method === "GET" ? "read" : "write")) {
        return forbidden();
      }
      if (method === "PATCH" && typeof input.body === "string") {
        pull.body = input.body;
      }
      return Response.json(pullJson(pull));
    }
    const comments = /^\/issues\/(\d+)\/comments$/.exec(rest);
    const commenting = can("pull_requests", "write") || can("issues", "write");
    if (comments?.[1]) {
      const number = Number(comments[1]);
      const thread = found.comments.get(number);
      if (thread === undefined) return notFound();
      if (method === "GET") {
        if (!can("pull_requests", "read") && !can("issues", "read")) {
          return forbidden();
        }
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const page = Number(url.searchParams.get("page") ?? "1");
        return Response.json(
          thread.slice((page - 1) * perPage, page * perPage),
        );
      }
      if (method === "POST") {
        if (!commenting) return forbidden();
        const comment = commentOn(
          thread,
          htmlBase,
          number,
          String(input.body ?? ""),
          {
            user: { id: APP_BOT_USER_ID, login: "agent-platform[bot]" },
            performed_via_github_app: { id: grant.appId },
          },
        );
        return Response.json(comment, { status: 201 });
      }
    }
    const edit = /^\/issues\/comments\/(\d+)$/.exec(rest);
    if (edit?.[1] && method === "PATCH") {
      if (!commenting) return forbidden();
      const comment = [...found.comments.values()]
        .flat()
        .find((entry) => entry.id === Number(edit[1]));
      if (comment === undefined) return notFound();
      comment.body = String(input.body ?? "");
      return Response.json(comment);
    }
    const review = /^\/pulls\/(\d+)\/reviews$/.exec(rest);
    if (review?.[1] && method === "POST") {
      if (!can("pull_requests", "write")) return forbidden();
      const pull = found.pulls.find(
        (entry) => entry.number === Number(review[1]),
      );
      if (pull === undefined) return notFound();
      const event = String(input.event ?? "COMMENT");
      if (event === "APPROVE" && pull.author_app_id === grant.appId) {
        return Response.json(
          {
            message: "Unprocessable Entity",
            errors: ["Can not approve your own pull request"],
          },
          { status: 422 },
        );
      }
      nextReviewId += 1;
      const submitted: FakeGitHubReview = {
        id: nextReviewId,
        pull_number: pull.number,
        commit_id: String(input.commit_id ?? ""),
        event,
        body: typeof input.body === "string" ? input.body : null,
        app_id: grant.appId,
      };
      found.reviews.push(submitted);
      const states: Record<string, string> = {
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
      };
      return Response.json({
        id: submitted.id,
        commit_id: submitted.commit_id,
        state: states[event] ?? "COMMENTED",
        html_url: `${htmlBase}/pull/${pull.number}#pullrequestreview-${submitted.id}`,
      });
    }
    const dispatch = /^\/actions\/workflows\/([^/]+)\/dispatches$/.exec(rest);
    if (dispatch?.[1] && method === "POST") {
      if (!can("actions", "write")) return forbidden();
      const inputs = (input.inputs ?? null) as Record<string, unknown> | null;
      if (failingDispatches) {
        // GitHub names an unexpected input, value included, in its answer.
        return Response.json(
          {
            message: `Unexpected inputs provided: ${JSON.stringify(inputs)}`,
          },
          { status: 422 },
        );
      }
      const ref = String(input.ref ?? "").replace(/^refs\/heads\//, "");
      nextRunId += 1;
      const run: FakeGitHubWorkflowRun = {
        id: nextRunId,
        path: `.github/workflows/${decodeURIComponent(dispatch[1])}`,
        head_branch: ref,
        event: "workflow_dispatch",
        status: "queued",
        conclusion: null,
        html_url: `${htmlBase}/actions/runs/${nextRunId}`,
        inputs,
        reruns: [],
      };
      found.runs.push(run);
      return input.return_run_details === true
        ? Response.json({
            workflow_run_id: run.id,
            run_url: `${origin()}/repos/${owner}/${name}/actions/runs/${run.id}`,
            html_url: run.html_url,
          })
        : new Response(null, { status: 204 });
    }
    const runs = /^\/actions\/runs\/(\d+)(\/rerun|\/rerun-failed-jobs)?$/.exec(
      rest,
    );
    if (runs?.[1]) {
      const run = found.runs.find((entry) => entry.id === Number(runs[1]));
      if (method === "GET" && runs[2] === undefined) {
        if (!can("actions", "read")) return forbidden();
        if (run === undefined) return notFound();
        const { inputs: _inputs, reruns: _reruns, ...shown } = run;
        return Response.json(shown);
      }
      if (method === "POST" && runs[2] !== undefined) {
        if (!can("actions", "write")) return forbidden();
        if (run === undefined) return notFound();
        run.reruns.push({ failedOnly: runs[2] === "/rerun-failed-jobs" });
        return Response.json({}, { status: 201 });
      }
    }
    return notFound();
  }

  // What a console asks with the App's JWT: the App itself, its one
  // installation (every served repository is in it), and which
  // installation covers a repository.
  const installationId = options.installationId ?? 1;
  const slug = options.slug ?? "fake-app";
  function appCall(request: Request, path: string): Response | undefined {
    const repository = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(path);
    if (
      request.method !== "GET" ||
      (path !== "/app" && path !== "/app/installations" && !repository)
    ) {
      return undefined;
    }
    const jwt = verifiedJwt(request.headers.get("authorization"));
    if (jwt === undefined) {
      return Response.json(
        { message: "A JSON web token could not be decoded" },
        { status: 401 },
      );
    }
    const isSecond = second !== undefined && Number(jwt.iss) === second.appId;
    const app = isSecond
      ? {
          id: second.appId,
          slug: second.slug ?? "fake-reviewer-app",
          installation: second.installationId,
          permissions: second.permissions ?? APP_PERMISSIONS_DEFAULT,
        }
      : {
          id: options.appId,
          slug,
          installation: installationId,
          permissions: granted ?? APP_PERMISSIONS_DEFAULT,
        };
    if (path === "/app") {
      return Response.json({
        id: app.id,
        slug: app.slug,
        name: `Fake ${app.slug}`,
        html_url: `${origin()}/apps/${app.slug}`,
        client_id: `Iv23li${app.slug}`,
        permissions: app.permissions,
      });
    }
    if (repository) {
      const key = `${repository[1]}/${repository[2]}`;
      return served.has(key) && installedOn(app.id, key)
        ? Response.json({
            id: app.installation,
            app_id: app.id,
            permissions: app.permissions,
          })
        : Response.json({ message: "Not Found" }, { status: 404 });
    }
    const [owner = "fake"] = [...served.keys()].map((key) => key.split("/")[0]);
    return Response.json([
      {
        id: app.installation,
        app_id: app.id,
        account: { login: owner, type: "Organization" },
        repository_selection: "selected",
        html_url: `${origin()}/organizations/${owner}/settings/installations/${app.installation}`,
      },
    ]);
  }

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v3(?=\/)/, "");
      if (path === "/healthz") return new Response("ok");
      const app = appCall(request, path);
      if (app !== undefined) return app;
      const tokens = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (tokens?.[1] && request.method === "POST") {
        return await accessTokens(request, Number(tokens[1]));
      }
      if (/^\/repos\//.test(path)) {
        const carried = installationToken(
          request.headers.get("authorization"),
          "token",
        );
        const body =
          request.method === "POST" || request.method === "PATCH"
            ? await request.json().catch(() => null)
            : undefined;
        const response = await rest(request.method, path, url, carried, body);
        apiRequests.push({
          at: now().toISOString(),
          method: request.method,
          path: `${path}${url.search}`,
          token: carried?.[1].index ?? null,
          ...(body === undefined ? {} : { body }),
          status: response.status,
        });
        return response;
      }
      const git = /^\/([^/]+)\/([^/]+?)\.git\//.exec(url.pathname);
      if (git?.[1] && git[2]) {
        const carried = installationToken(
          request.headers.get("authorization"),
          "basic",
        );
        const push =
          url.pathname.endsWith("/git-receive-pack") ||
          url.searchParams.get("service") === "git-receive-pack";
        const allowed =
          carried !== undefined &&
          carried[1].permissions.contents !== undefined &&
          reaches(carried[1], git[1], git[2]);
        const writes = carried?.[1].permissions.contents === "write";
        const response = !allowed
          ? new Response("authentication required\n", {
              status: 401,
              headers: { "www-authenticate": 'Basic realm="GitHub"' },
            })
          : push && !writes
            ? new Response("Write access to repository not granted.\n", {
                status: 403,
              })
            : await serveGitHttp(
                join(root, git[1]),
                request,
                gitUrl(url, git[1]),
                push ? { remoteUser: "x-access-token" } : {},
              );
        gitRequests.push({
          at: now().toISOString(),
          method: request.method,
          path: `${url.pathname}${url.search}`,
          push,
          token: carried?.[1].index ?? null,
          status: response.status,
        });
        return response;
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  let nextId = 1000;
  return {
    origin: origin(),
    port: server.port ?? 0,
    tokenRequests,
    gitRequests,
    apiRequests,
    failTokens(on) {
      failing = on;
    },
    setPermissions(permissions) {
      granted = permissions;
    },
    failDispatches(on) {
      failingDispatches = on;
    },
    addWorkflowRun(owner, name, run) {
      const found = served.get(`${owner}/${name}`);
      if (!found) throw new Error(`no repository ${owner}/${name}`);
      nextRunId += 1;
      found.runs.push({
        id: nextRunId,
        path: run.path,
        head_branch: run.head_branch,
        event: run.event ?? "push",
        status: "completed",
        conclusion: "failure",
        html_url: `${origin()}/${owner}/${name}/actions/runs/${nextRunId}`,
        inputs: null,
        reruns: [],
      });
      return nextRunId;
    },
    workflowRuns(owner, name) {
      return served.get(`${owner}/${name}`)?.runs ?? [];
    },
    reviews(owner, name, pullNumber) {
      return (served.get(`${owner}/${name}`)?.reviews ?? []).filter(
        (entry) => entry.pull_number === pullNumber,
      );
    },
    rateLimitNext(count, limit, retryAfterSeconds = 1) {
      limited = { count, limit, retryAfter: retryAfterSeconds };
    },
    pullRequests(owner, name) {
      return served.get(`${owner}/${name}`)?.pulls ?? [];
    },
    comments(owner, name, number) {
      return served.get(`${owner}/${name}`)?.comments.get(number) ?? [];
    },
    addComment(owner, name, number, body) {
      const thread = served.get(`${owner}/${name}`)?.comments.get(number);
      if (thread === undefined) throw new Error(`no pull request ${number}`);
      return commentOn(thread, `${origin()}/${owner}/${name}`, number, body, {
        user: { id: 7, login: "octocat" },
        performed_via_github_app: null,
      });
    },
    async createRepository(owner, name, files, repoOptions = {}) {
      const branch = repoOptions.branch ?? "main";
      await mkdir(join(root, owner), { recursive: true });
      await createServedRepository(
        { root: join(root, owner) },
        name,
        files,
        branch,
      );
      nextId += 1;
      served.set(`${owner}/${name}`, {
        id: nextId,
        defaultBranch: branch,
        private: repoOptions.private ?? true,
        pulls: [],
        comments: new Map(),
        runs: [],
        reviews: [],
      });
    },
    async refs(owner, name) {
      const listed = await runTestGit(
        ["for-each-ref", "--format=%(refname) %(objectname)"],
        join(root, owner, `${name}.git`),
      );
      return Object.fromEntries(
        listed
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.split(" ") as [string, string]),
      );
    },
    async writeUnrelatedCommit(owner, name, branch) {
      const bare = join(root, owner, `${name}.git`);
      const commit = (
        await runTestGit(
          [
            "-c",
            "user.name=testkit",
            "-c",
            "user.email=testkit@example.test",
            "commit-tree",
            "HEAD^{tree}",
            "-m",
            "unrelated",
          ],
          bare,
        )
      ).trim();
      await runTestGit(["update-ref", `refs/heads/${branch}`, commit], bare);
      return commit;
    },
    async setDefaultBranch(owner, name, branch) {
      const found = served.get(`${owner}/${name}`);
      if (!found) throw new Error(`no repository ${owner}/${name}`);
      await runTestGit(
        ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
        join(root, owner, `${name}.git`),
      );
      found.defaultBranch = branch;
    },
    async stop() {
      server.stop(true);
      await rm(root, { force: true, recursive: true });
    },
  };
}

// http-backend serves paths under its project root, which is the owner's
// directory here: `/<owner>/<name>.git/...` → `/<name>.git/...`.
function gitUrl(url: URL, owner: string): URL {
  const inner = new URL(url);
  inner.pathname = url.pathname.slice(owner.length + 1);
  return inner;
}

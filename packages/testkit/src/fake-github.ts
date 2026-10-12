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

export type FakeGitHub = {
  /** `http://<host>:<port>`: both the API base and the git origin. */
  readonly origin: string;
  readonly port: number;
  readonly tokenRequests: FakeGitHubTokenRequest[];
  readonly gitRequests: FakeGitHubGitRequest[];
  /** While on, the token endpoint answers 500. */
  failTokens(on: boolean): void;
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
};

type Issued = {
  index: number;
  installationId: number;
  /** Null when the request named no repositories: every one is reachable. */
  repositories: string[] | null;
  permissions: Record<string, string>;
  expiresAt: Date;
};

type Served = { id: number; defaultBranch: string; private: boolean };

/**
 * A GitHub App's side of GitHub for tests and the local stack: the
 * installation token endpoint (RS256 JWT checked against the App's public
 * key), `GET /repos/:owner/:name`, and git smart HTTP that takes only an
 * unexpired installation token scoped to the repository. API paths are
 * also served under `/api/v3`, as on GHES. A push (receive-pack) needs a
 * token whose permissions say `contents: write`; a read token gets a 403,
 * as on GitHub.
 */
export async function startFakeGitHub(
  options: FakeGitHubOptions,
): Promise<FakeGitHub> {
  const root = await mkdtemp(join(tmpdir(), "testkit-fake-github-"));
  const publicKey = createPublicKey(options.publicKey);
  const now = options.now ?? (() => new Date());
  const ttlMs = (options.tokenTtlSeconds ?? 3600) * 1000;
  const tokenRequests: FakeGitHubTokenRequest[] = [];
  const gitRequests: FakeGitHubGitRequest[] = [];
  const issued = new Map<string, Issued>();
  const served = new Map<string, Served>();
  let failing = false;

  function verifiedJwt(authorization: string | null) {
    const jwt = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
    const [head, body, signature] = jwt?.split(".") ?? [];
    if (!head || !body || !signature) return undefined;
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${head}.${body}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    if (!signed) return undefined;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString());
    const seconds = Math.floor(now().getTime() / 1000);
    if (
      String(claims.iss) !== String(options.appId) ||
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
    const asked = body as {
      repositories?: string[];
      permissions?: Record<string, string>;
    } | null;
    const token = `ghs_${randomBytes(18).toString("base64url")}`;
    const expiresAt = new Date(now().getTime() + ttlMs);
    issued.set(token, {
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

  function reaches(grant: Issued, owner: string, name: string): boolean {
    return (
      served.has(`${owner}/${name}`) &&
      (grant.repositories === null || grant.repositories.includes(name))
    );
  }

  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v3(?=\/)/, "");
      if (path === "/healthz") return new Response("ok");
      const tokens = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (tokens?.[1] && request.method === "POST") {
        return await accessTokens(request, Number(tokens[1]));
      }
      const repo = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
      if (repo?.[1] && repo[2] && request.method === "GET") {
        const grant = installationToken(
          request.headers.get("authorization"),
          "token",
        )?.[1];
        const found = served.get(`${repo[1]}/${repo[2]}`);
        if (!found || !grant || !reaches(grant, repo[1], repo[2])) {
          return Response.json({ message: "Not Found" }, { status: 404 });
        }
        return Response.json({
          id: found.id,
          name: repo[2],
          full_name: `${repo[1]}/${repo[2]}`,
          default_branch: found.defaultBranch,
          private: found.private,
        });
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
    origin: `http://${options.hostname ?? "127.0.0.1"}:${server.port}`,
    port: server.port ?? 0,
    tokenRequests,
    gitRequests,
    failTokens(on) {
      failing = on;
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

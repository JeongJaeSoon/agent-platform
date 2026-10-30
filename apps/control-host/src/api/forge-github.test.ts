import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForgeCredentialError,
  GitHubAppCheckError,
  type GitHubAppCredential,
  GitHubPermissionError,
  type SessionCatalog,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import {
  connectionsOf,
  createGitHubAppDirectory,
  createGitHubConnection,
  createRegisteredGitHubConnection,
  REFRESH_BEFORE_EXPIRY_MS,
} from "./forge-github.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const repo = { owner: "acme", name: "app" };
const READ = { contents: "read" } as const;
const WRITE = { contents: "write" } as const;

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.createRepository("acme", "other", { "README.md": "no\n" });
});
afterAll(async () => {
  await github.stop();
});

function appConnection(options: { now?: () => Date; apiBase?: string } = {}) {
  const warnings: Array<Record<string, unknown>> = [];
  const connection = createGitHubConnection({
    apiBase: options.apiBase ?? github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    ...(options.now === undefined ? {} : { now: options.now }),
    retryAfterBaseMs: 1,
    paced: false,
    logger: {
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push({ message, ...fields }),
    },
  });
  return { connection, warnings };
}

async function clone(url: string, authorization: string) {
  const dir = await mkdtemp(join(tmpdir(), "forge-clone-"));
  try {
    const child = Bun.spawn(
      [
        "git",
        "-c",
        `http.extraHeader=Authorization: ${authorization}`,
        "clone",
        "--quiet",
        url,
        join(dir, "checkout"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
        stderr: "pipe",
      },
    );
    const code = await child.exited;
    if (code !== 0) return null;
    return await Bun.file(join(dir, "checkout", "README.md")).text();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

const basic = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("a GitHub App connection", () => {
  test("asks for a token scoped to the one repository and the permissions named, with a JWT the App signed", async () => {
    const before = github.tokenRequests.length;
    const started = Math.floor(Date.now() / 1000);
    const { connection } = appConnection();
    expect(connection).toMatchObject({
      kind: "app",
      appId: 101,
      githubCom: false,
    });
    const { credential, fresh } = await connection.credential(repo, READ);
    expect(fresh).toBe(true);
    const [asked] = github.tokenRequests.slice(before);
    expect(github.tokenRequests.length - before).toBe(1);
    expect(asked).toMatchObject({
      installationId: 202,
      status: 201,
      body: { repositories: ["app"], permissions: { contents: "read" } },
      jwt: { iss: "101" },
    });
    const jwt = asked?.jwt;
    if (!jwt) throw new Error("no JWT");
    // Back-dated against clock skew, and inside GitHub's 10-minute cap.
    expect(jwt.iat).toBeLessThan(started);
    expect(jwt.exp - jwt.iat).toBeLessThanOrEqual(600);
    expect(credential.username).toBe("x-access-token");
    expect(credential.expiresAt).toBeInstanceOf(Date);

    // The token clones that repository, and no other.
    const authorization = basic(credential.username, credential.password);
    expect(await clone(`${github.origin}/acme/app.git`, authorization)).toBe(
      "hello\n",
    );
    expect(await clone(`${github.origin}/acme/other.git`, authorization)).toBe(
      null,
    );
  });

  test("keeps a token per repository and permission set, and re-issues it ten minutes before it expires", async () => {
    let offset = 0;
    const { connection } = appConnection({
      now: () => new Date(Date.now() + offset),
    });
    const before = github.tokenRequests.length;
    const first = await connection.credential(repo, READ);
    const cached = await connection.credential(repo, READ);
    expect(cached.credential.password).toBe(first.credential.password);
    expect(cached.fresh).toBe(false);
    expect(github.tokenRequests.length - before).toBe(1);

    const expiresAt = first.credential.expiresAt?.getTime() ?? 0;
    offset = expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now() - 5_000;
    expect((await connection.credential(repo, READ)).credential.password).toBe(
      first.credential.password,
    );
    offset = expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now() + 1_000;
    const second = await connection.credential(repo, READ);
    expect(second.credential.password).not.toBe(first.credential.password);
    expect(second.fresh).toBe(true);
    expect(github.tokenRequests.length - before).toBe(2);

    // Write access is its own token, asked with contents:write.
    await connection.credential(repo, WRITE);
    expect(github.tokenRequests.at(-1)?.body).toEqual({
      repositories: ["app"],
      permissions: { contents: "write" },
    });
    expect(github.tokenRequests.length - before).toBe(3);

    // The same permissions in another order are the same token.
    offset = 0;
    await connection.credential(repo, {
      pull_requests: "write",
      contents: "read",
    });
    await connection.credential(repo, {
      contents: "read",
      pull_requests: "write",
    });
    expect(github.tokenRequests.length - before).toBe(4);
  });

  test("concurrent asks for the same token issue it once", async () => {
    const { connection } = appConnection();
    const before = github.tokenRequests.length;
    const all = await Promise.all(
      Array.from({ length: 8 }, () => connection.credential(repo, READ)),
    );
    expect(new Set(all.map((c) => c.credential.password)).size).toBe(1);
    expect(all.filter((c) => c.fresh)).toHaveLength(1);
    expect(github.tokenRequests.length - before).toBe(1);
  });

  test("a failing token endpoint fails the ask, naming the status and GitHub's message", async () => {
    const { connection, warnings } = appConnection();
    const before = github.tokenRequests.length;
    github.failTokens(true);
    try {
      const error = await connection.credential(repo, READ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ForgeCredentialError);
      expect((error as Error).message).toBe(
        "GitHub installation token request failed (500)",
      );
      expect(warnings).toEqual([
        {
          message: "GitHub request failed",
          request: "installation token request",
          status: 500,
          error: "HttpError",
          github_reason: "Server Error",
        },
      ]);
      expect(github.tokenRequests.length - before).toBe(3);
    } finally {
      github.failTokens(false);
    }
    // Nothing failed is cached: the next ask issues.
    expect((await connection.credential(repo, READ)).credential.username).toBe(
      "x-access-token",
    );
  });

  test("permissions the installation does not grant are a GitHubPermissionError", async () => {
    const { connection, warnings } = appConnection();
    github.setPermissions({ contents: "read", metadata: "read" });
    try {
      const refused = await connection.credential(repo, WRITE).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(GitHubPermissionError);
      expect(github.tokenRequests.at(-1)?.status).toBe(422);
      expect(warnings).toMatchObject([
        { request: "installation token request", status: 422 },
      ]);
      // What it does grant is still issued.
      expect((await connection.credential(repo, READ)).fresh).toBe(true);
    } finally {
      github.setPermissions(undefined);
    }
  });

  test("a GHES API base under /api/v3 works the same", async () => {
    const before = github.tokenRequests.length;
    const { connection } = appConnection({
      apiBase: `${github.origin}/api/v3/`,
    });
    expect(connection.githubCom).toBe(false);
    const { credential } = await connection.credential(repo, READ);
    expect(github.tokenRequests.length - before).toBe(1);
    expect(await connection.api(repo, credential).getRepository()).toEqual({
      id: expect.any(Number),
      defaultBranch: "main",
      private: true,
    });
  });

  test("names itself Werft in the User-Agent", async () => {
    const calls = spyOn(globalThis, "fetch");
    try {
      const { connection } = appConnection();
      const { credential } = await connection.credential(repo, READ);
      await connection.api(repo, credential).getRepository();
      // Another file's unrestored fetch spy can be the one returned here, so
      // only requests to this fake GitHub count.
      const agents = calls.mock.calls
        .filter(([url]) => String(url).startsWith(github.origin))
        .map(([, init]) => new Headers(init?.headers).get("user-agent"));
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) expect(agent).toStartWith("Werft ");
    } finally {
      calls.mockRestore();
    }
  });
});

describe("connectionsOf", () => {
  const base = { branch: "main", profiles: ["p"] };
  const catalog: SessionCatalog = {
    profiles: {},
    repositories: {
      app: {
        ...base,
        url: "https://github.com/acme/app.git",
        auth: {
          kind: "github_app",
          app_id: 101,
          installation_id: 202,
          api_base: "https://api.github.com",
          value: privateKey,
          ref: { value_env: "K" },
        },
      },
      pat: {
        ...base,
        url: "https://github.com/acme/pat.git",
        auth: {
          kind: "basic",
          username: "x-access-token",
          value: "github_pat_fixture_value",
          ref: { value_env: "P" },
        },
      },
      gitea: {
        ...base,
        url: "http://gitea:3000/agent/sample.git",
        auth: {
          kind: "basic",
          username: "agent",
          value: "gitea-token-fixture",
          ref: { value_env: "G" },
        },
      },
      public: { ...base, url: "https://github.com/acme/open.git" },
    },
  };

  test("an App or a github.com PAT has an author connection; Gitea, public repositories and the reviewer role have none", async () => {
    const connections = connectionsOf(catalog);
    expect(connections("app", "author")).toMatchObject({
      kind: "app",
      appId: 101,
      githubCom: true,
    });
    const pat = connections("pat", "author");
    expect(pat).toMatchObject({ kind: "pat", appId: null, githubCom: true });
    expect(await pat?.credential(repo, READ)).toEqual({
      credential: {
        username: "x-access-token",
        password: "github_pat_fixture_value",
      },
      fresh: false,
    });
    expect(connections("app", "author")).toBe(connections("app", "author"));
    expect(connections("app", "reviewer")).toBeNull();
    expect(connections("gitea", "author")).toBeNull();
    expect(connections("public", "author")).toBeNull();
    expect(connections("missing", "author")).toBeNull();
  });
});

describe("the App registered in the console", () => {
  const credential = (fields: Partial<GitHubAppCredential> = {}) => ({
    id: "8b0d2f4e-0000-4000-8000-000000000001",
    workspaceId: "8b0d2f4e-0000-4000-8000-0000000000aa",
    appId: 101,
    apiBase: github.origin,
    privateKey,
    updatedAt: new Date("2026-10-30T00:00:00Z"),
    ...fields,
  });

  test("finds the installation that covers the repository, then asks for a token on it", async () => {
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: { credentials: async () => [credential()] },
      paced: false,
    });
    expect(registered.connection()).toBeNull();
    await registered.refresh();
    const before = github.tokenRequests.length;
    const issued = await registered.connection()?.credential(repo, READ);
    expect(issued?.credential.username).toBe("x-access-token");
    const [asked] = github.tokenRequests.slice(before);
    expect(asked).toMatchObject({
      installationId: 1,
      status: 201,
      body: { repositories: ["app"], permissions: { contents: "read" } },
    });
  });

  test("reads its own role's App only, with the other registered beside it", async () => {
    const asked: string[] = [];
    const reviewer = createRegisteredGitHubConnection({
      role: "reviewer",
      store: {
        credentials: async (role: "author" | "reviewer") => {
          asked.push(role);
          return [credential({ appId: role === "reviewer" ? 202 : 101 })];
        },
      },
    });
    await reviewer.refresh();
    expect(asked).toEqual(["reviewer"]);
    expect(reviewer.connection()?.appId).toBe(202);
    asked.length = 0;
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: {
        credentials: async (role: "author" | "reviewer") => {
          asked.push(role);
          // GitHub knows no App 999, so a token from it would fail.
          return role === "reviewer"
            ? [
                credential({
                  id: "8b0d2f4e-0000-4000-8000-000000000002",
                  appId: 999,
                }),
              ]
            : [credential()];
        },
      },
      paced: false,
    });
    await registered.refresh();
    const before = github.tokenRequests.length;
    expect(
      (await registered.connection()?.credential(repo, WRITE))?.credential
        .username,
    ).toBe("x-access-token");
    expect(asked).toEqual(["author"]);
    expect(github.tokenRequests.slice(before)).toMatchObject([
      { status: 201, body: { permissions: { contents: "write" } } },
    ]);
  });

  test("a repository the App is not installed on fails the ask by name", async () => {
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: { credentials: async () => [credential()] },
      paced: false,
    });
    await registered.refresh();
    const asking = registered
      .connection()
      ?.credential({ owner: "acme", name: "absent" }, READ);
    await expect(asking).rejects.toThrow(
      new ForgeCredentialError("GitHub App is not installed on acme/absent"),
    );
  });

  test("a replaced App or key gets a new connection; a removed one leaves none", async () => {
    let held = [credential()];
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: { credentials: async () => held },
    });
    await registered.refresh();
    const first = registered.connection();
    await registered.refresh();
    expect(registered.connection()).toBe(first);
    held = [credential({ updatedAt: new Date("2026-10-30T01:00:00Z") })];
    await registered.refresh();
    expect(registered.connection()).not.toBe(first);
    held = [];
    await registered.refresh();
    expect(registered.connection()).toBeNull();
  });

  test("a slow read from before a delete cannot bring the App back", async () => {
    let release: () => void = () => {};
    const reads = [
      new Promise<ReturnType<typeof credential>[]>((resolve) => {
        release = () => resolve([credential()]);
      }),
      Promise.resolve([]),
    ];
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: { credentials: () => reads.shift() ?? Promise.resolve([]) },
    });
    const periodic = registered.refresh();
    const afterDelete = registered.refresh();
    release();
    await Promise.all([periodic, afterDelete]);
    expect(registered.connection()).toBeNull();
  });

  test("connectionsOf hands each role's App to repositories written as { kind: github_app }", async () => {
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: { credentials: async () => [credential()] },
    });
    const reviewer = createRegisteredGitHubConnection({
      role: "reviewer",
      store: { credentials: async () => [credential({ appId: 202 })] },
    });
    const connections = connectionsOf(
      {
        profiles: {},
        repositories: {
          app: {
            branch: "main",
            url: "https://github.com/acme/app.git",
            auth: { kind: "github_app", registered: true },
          },
          open: { branch: "main", url: "https://github.com/acme/open.git" },
        },
      },
      {
        registered: (role) =>
          (role === "author" ? registered : reviewer).connection(),
      },
    );
    expect(connections("app", "author")).toBeNull();
    await registered.refresh();
    expect(connections("app", "author")).toBe(registered.connection());
    expect(connections("app", "reviewer")).toBeNull();
    await reviewer.refresh();
    expect(connections("app", "reviewer")).toBe(reviewer.connection());
    expect(connections("app", "reviewer")?.appId).toBe(202);
    expect(connections("open", "author")).toBeNull();
    expect(connections("open", "reviewer")).toBeNull();
  });

  test("installed asks GitHub with the App's JWT and issues no token", async () => {
    const registered = createRegisteredGitHubConnection({
      role: "author",
      store: { credentials: async () => [credential()] },
    });
    await registered.refresh();
    const before = github.tokenRequests.length;
    expect(await registered.connection()?.installed(repo)).toBe(true);
    expect(
      await registered
        .connection()
        ?.installed({ owner: "acme", name: "absent" }),
    ).toBe(false);
    expect(github.tokenRequests.length).toBe(before);
  });

  test("a catalog App is installed only where its named installation covers the repository", async () => {
    const catalogApp = (installationId: number) =>
      createGitHubConnection({
        apiBase: github.origin,
        credentials: { kind: "app", appId: 101, installationId, privateKey },
        paced: false,
      });
    const before = github.tokenRequests.length;
    // The fake's one installation is 1.
    expect(await catalogApp(1).installed(repo)).toBe(true);
    expect(await catalogApp(202).installed(repo)).toBe(false);
    expect(
      await catalogApp(1).installed({ owner: "acme", name: "absent" }),
    ).toBe(false);
    expect(github.tokenRequests.length).toBe(before);
  });
});

describe("createGitHubAppDirectory", () => {
  const directory = createGitHubAppDirectory({ retryAfterBaseMs: 1 });
  const app = () => ({ appId: 101, apiBase: github.origin, privateKey });

  test("describes the App with its permissions, lists its installation, and finds it per repository", async () => {
    expect(await directory.describe(app())).toEqual({
      appId: 101,
      slug: "fake-app",
      name: "Fake fake-app",
      htmlUrl: `${github.origin}/apps/fake-app`,
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    });
    github.setPermissions({ actions: "write", contents: "read" });
    try {
      expect((await directory.describe(app())).permissions).toEqual({
        actions: "write",
        contents: "read",
      });
    } finally {
      github.setPermissions(undefined);
    }
    expect(await directory.installations(app())).toEqual([
      {
        id: 1,
        account: "acme",
        repositorySelection: "selected",
        htmlUrl: `${github.origin}/organizations/acme/settings/installations/1`,
      },
    ]);
    expect(await directory.installationFor(app(), repo)).toEqual({
      id: 1,
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    });
    expect(
      await directory.installationFor(app(), { owner: "acme", name: "absent" }),
    ).toBeNull();
  });

  test("a key GitHub does not know for the id is rejected; no answer is unreachable", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString();
    const rejected = directory.describe({ ...app(), privateKey: other });
    await expect(rejected).rejects.toMatchObject({ reason: "github_rejected" });
    await expect(rejected).rejects.toBeInstanceOf(GitHubAppCheckError);
    const wrongId = directory.describe({ ...app(), appId: 999 });
    await expect(wrongId).rejects.toMatchObject({ reason: "github_rejected" });
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const unreachable = `http://127.0.0.1:${closed.port}`;
    closed.stop(true);
    await expect(
      directory.describe({ ...app(), apiBase: unreachable }),
    ).rejects.toMatchObject({ reason: "github_unreachable" });
  });
});

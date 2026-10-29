import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForgeCredentialError,
  GitHubAppCheckError,
  type GitHubAppCredential,
  type SessionCatalog,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import {
  createGitHubAppDirectory,
  createGitHubForge,
  createRegisteredGitHubForge,
  forgesOf,
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

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  await github.createRepository("acme", "other", { "README.md": "no\n" });
});
afterAll(async () => {
  await github.stop();
});

function appForge(options: { now?: () => Date; apiBase?: string } = {}) {
  const warnings: Array<Record<string, unknown>> = [];
  const forge = createGitHubForge({
    apiBase: options.apiBase ?? github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    ...(options.now === undefined ? {} : { now: options.now }),
    retryAfterBaseMs: 1,
    paced: false,
    logger: {
      warn: (message, fields) => warnings.push({ message, ...fields }),
    },
  });
  return { forge, warnings };
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

describe("GitHub App forge", () => {
  test("asks for a token scoped to the one repository and contents:read, with a JWT the App signed", async () => {
    const before = github.tokenRequests.length;
    const started = Math.floor(Date.now() / 1000);
    const { forge } = appForge();
    const credential = await forge.gitCredential(repo, "read");
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

  test("keeps a token per repository and access, and re-issues it ten minutes before it expires", async () => {
    let offset = 0;
    const { forge } = appForge({ now: () => new Date(Date.now() + offset) });
    const before = github.tokenRequests.length;
    const first = await forge.gitCredential(repo, "read");
    expect((await forge.gitCredential(repo, "read")).password).toBe(
      first.password,
    );
    expect(github.tokenRequests.length - before).toBe(1);

    const expiresAt = first.expiresAt?.getTime() ?? 0;
    offset = expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now() - 5_000;
    expect((await forge.gitCredential(repo, "read")).password).toBe(
      first.password,
    );
    offset = expiresAt - REFRESH_BEFORE_EXPIRY_MS - Date.now() + 1_000;
    const second = await forge.gitCredential(repo, "read");
    expect(second.password).not.toBe(first.password);
    expect(github.tokenRequests.length - before).toBe(2);

    // Write access is its own token, asked with contents:write.
    await forge.gitCredential(repo, "write");
    expect(github.tokenRequests.at(-1)?.body).toEqual({
      repositories: ["app"],
      permissions: { contents: "write" },
    });
    expect(github.tokenRequests.length - before).toBe(3);
  });

  test("concurrent asks for the same token issue it once", async () => {
    const { forge } = appForge();
    const before = github.tokenRequests.length;
    const all = await Promise.all(
      Array.from({ length: 8 }, () => forge.gitCredential(repo, "read")),
    );
    expect(new Set(all.map((c) => c.password)).size).toBe(1);
    expect(github.tokenRequests.length - before).toBe(1);
  });

  test("a failing token endpoint fails the ask, naming the status and GitHub's message", async () => {
    const { forge, warnings } = appForge();
    const before = github.tokenRequests.length;
    github.failTokens(true);
    try {
      const error = await forge.gitCredential(repo, "read").then(
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
    expect((await forge.gitCredential(repo, "read")).username).toBe(
      "x-access-token",
    );
  });

  test("a GHES API base under /api/v3 works the same", async () => {
    const before = github.tokenRequests.length;
    const { forge } = appForge({ apiBase: `${github.origin}/api/v3/` });
    await forge.gitCredential(repo, "read");
    expect(github.tokenRequests.length - before).toBe(1);
    expect(await forge.getRepository(repo)).toEqual({
      id: expect.any(Number),
      defaultBranch: "main",
      private: true,
    });
  });

  test("names itself Werft in the User-Agent", async () => {
    const calls = spyOn(globalThis, "fetch");
    try {
      const { forge } = appForge();
      await forge.getRepository(repo);
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

describe("forgesOf", () => {
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

  test("an App or a github.com PAT has a GitHub forge; Gitea and public repositories have none", async () => {
    const forges = forgesOf(catalog);
    expect(forges("app")?.kind).toBe("github");
    expect(await forges("pat")?.gitCredential(repo, "read")).toEqual({
      username: "x-access-token",
      password: "github_pat_fixture_value",
    });
    expect(forges("gitea")).toBeNull();
    expect(forges("public")).toBeNull();
    expect(forges("missing")).toBeNull();
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
    const registered = createRegisteredGitHubForge({
      store: { credentials: async () => [credential()] },
      paced: false,
    });
    expect(registered.forge()).toBeNull();
    await registered.refresh();
    const before = github.tokenRequests.length;
    const issued = await registered.forge()?.gitCredential(repo, "read");
    expect(issued?.username).toBe("x-access-token");
    const [asked] = github.tokenRequests.slice(before);
    expect(asked).toMatchObject({
      installationId: 1,
      status: 201,
      body: { repositories: ["app"], permissions: { contents: "read" } },
    });
  });

  test("a repository the App is not installed on fails the ask by name", async () => {
    const registered = createRegisteredGitHubForge({
      store: { credentials: async () => [credential()] },
      paced: false,
    });
    await registered.refresh();
    const asking = registered
      .forge()
      ?.gitCredential({ owner: "acme", name: "absent" }, "read");
    await expect(asking).rejects.toThrow(
      new ForgeCredentialError("GitHub App is not installed on acme/absent"),
    );
  });

  test("a replaced App or key gets a new forge; a removed one leaves none", async () => {
    let held = [credential()];
    const registered = createRegisteredGitHubForge({
      store: { credentials: async () => held },
    });
    await registered.refresh();
    const first = registered.forge();
    await registered.refresh();
    expect(registered.forge()).toBe(first);
    held = [credential({ updatedAt: new Date("2026-10-30T01:00:00Z") })];
    await registered.refresh();
    expect(registered.forge()).not.toBe(first);
    held = [];
    await registered.refresh();
    expect(registered.forge()).toBeNull();
  });

  test("a slow read from before a delete cannot bring the App back", async () => {
    let release: () => void = () => {};
    const reads = [
      new Promise<ReturnType<typeof credential>[]>((resolve) => {
        release = () => resolve([credential()]);
      }),
      Promise.resolve([]),
    ];
    const registered = createRegisteredGitHubForge({
      store: { credentials: () => reads.shift() ?? Promise.resolve([]) },
    });
    const periodic = registered.refresh();
    const afterDelete = registered.refresh();
    release();
    await Promise.all([periodic, afterDelete]);
    expect(registered.forge()).toBeNull();
  });

  test("forgesOf hands it to repositories written as { kind: github_app }", async () => {
    const registered = createRegisteredGitHubForge({
      store: { credentials: async () => [credential()] },
    });
    const forges = forgesOf(
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
      { registered: registered.forge },
    );
    expect(forges("app")).toBeNull();
    await registered.refresh();
    expect(forges("app")).toBe(registered.forge());
    expect(forges("open")).toBeNull();
  });
});

describe("createGitHubAppDirectory", () => {
  const directory = createGitHubAppDirectory({ retryAfterBaseMs: 1 });
  const app = () => ({ appId: 101, apiBase: github.origin, privateKey });

  test("describes the App, lists its installation, and finds it per repository", async () => {
    expect(await directory.describe(app())).toEqual({
      appId: 101,
      slug: "fake-app",
      name: "Fake fake-app",
      htmlUrl: `${github.origin}/apps/fake-app`,
    });
    expect(await directory.installations(app())).toEqual([
      {
        id: 1,
        account: "acme",
        repositorySelection: "selected",
        htmlUrl: `${github.origin}/organizations/acme/settings/installations/1`,
      },
    ]);
    expect(await directory.installationFor(app(), repo)).toBe(1);
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

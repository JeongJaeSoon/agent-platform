import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  type AgentDetail,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type GitHubAppRepositories,
  githubRepositoryWriteResponseSchema,
  listAgentGitHubRepositoriesResponseSchema,
  listGitHubRepositoriesResponseSchema,
  pickAgentGitHubRepositoryResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type CatalogRepositoryRow,
  type CatalogRepositoryStore,
  createAuthorizationPolicy,
  createGitHubRepositoryService,
  type GitHubAppStore,
  type IdentityStore,
  type InstallationProfileEntry,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { createGitHubAppDirectory } from "../forge-github.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerGitHubRepositoryRoutes } from "./github-repositories.ts";

const createApiApp = recordRouteErrors("routes/github-repositories.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const LISTED_AGENT = "019a0000-0000-7000-8000-0000000000c2";
const APP_ID = 4242;
const INSTALLATION = 77;

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId: WORKSPACE,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  async find(candidate: Uint8Array) {
    if (!Buffer.from(hashApiKey(KEY.plaintext)).equals(Buffer.from(candidate)))
      return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: "personal" as const,
      agentId: null,
      createdByUserId: crypto.randomUUID(),
      creatorRole: "owner" as const,
      scopes: ["sessions:read" as const, "sessions:write" as const],
    };
  },
};

let github: FakeGitHub;
let appRegistered = true;

function appStore(): GitHubAppStore {
  const at = new Date();
  const record = {
    id: "app-row",
    workspaceId: WORKSPACE,
    appId: APP_ID,
    slug: "werft-test",
    name: "Werft test",
    htmlUrl: "https://github.com/apps/werft-test",
    clientId: null,
    permissions: {},
    permissionsCheckedAt: at,
    createdAt: at,
    updatedAt: at,
    privateKey: { updatedAt: at, updatedBy: null },
  };
  return {
    async find(workspaceId, role) {
      if (!appRegistered || role !== "author" || workspaceId !== WORKSPACE)
        return null;
      return { ...record, apiBase: github.origin };
    },
    async credentials(role) {
      if (!appRegistered || role !== "author") return [];
      return [
        {
          id: record.id,
          workspaceId: WORKSPACE,
          appId: APP_ID,
          apiBase: github.origin,
          privateKey: keys.privateKey,
          updatedAt: at,
        },
      ];
    },
  } as GitHubAppStore;
}

// The Postgres store's locking and numbering are its own integration test;
// this one keeps what the routes need.
function memoryRepositories() {
  const rows = new Map<string, CatalogRepositoryRow>();
  const receipts: Array<{ operation: string; id: string; receipt: string }> =
    [];
  const counts = new Map<string, { author: number; reviewer: number }>();
  const store: CatalogRepositoryStore = {
    async listActive() {
      return [...rows.values()];
    },
    async readCatalog() {
      return rows.size === 0 ? null : store.listActive();
    },
    async seed() {
      return [];
    },
    async resolve(input) {
      const held = [...rows.values()].find(
        (row) =>
          row.github_repository_id === input.githubRepositoryId ||
          `${row.owner}/${row.name}`.toLowerCase() ===
            `${input.owner}/${input.name}`.toLowerCase(),
      );
      if (held) {
        held.github_repository_id ??= input.githubRepositoryId;
        return {
          outcome: "resolved",
          repository: held,
          created: false,
          changed: false,
        };
      }
      let id = input.base;
      for (let n = 2; rows.has(id) || input.reserved.has(id); n += 1) {
        id = `${input.base}-${n}`;
      }
      const at = new Date().toISOString();
      const row = {
        id,
        github_repository_id: input.githubRepositoryId,
        owner: input.owner,
        name: input.name,
        url: input.url,
        branch: input.branch,
        profiles: null,
        source: "selection" as const,
        version: 1,
        created_at: at,
        updated_at: at,
      };
      rows.set(id, row);
      receipts.push({
        operation: "resolve_repository",
        id,
        receipt: input.receiptId,
      });
      return {
        outcome: "resolved",
        repository: row,
        created: true,
        changed: true,
      };
    },
    async setBranch(input) {
      const row = rows.get(input.id);
      if (row === undefined) return { outcome: "not_found" };
      if (row.version !== input.version) {
        return { outcome: "revision_conflict" };
      }
      row.branch = input.branch;
      row.version += 1;
      receipts.push({
        operation: "set_repository_branch",
        id: input.id,
        receipt: input.receiptId,
      });
      return { outcome: "stored", repository: { ...row } };
    },
    async agentCounts() {
      return counts;
    },
  };
  return { store, receipts, rows, counts };
}

const logs = new MemoryLogSink();
const memory = memoryRepositories();
let changes = 0;

const ceiling = (
  id: string,
  apps: GitHubAppRepositories,
): [string, InstallationProfileEntry] => [
  id,
  {
    id,
    origin: "console",
    state: "usable",
    repository_ids: [],
    github_app_repositories: apps,
  },
];

function appWith() {
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    registerRoutes: (router) =>
      registerGitHubRepositoryRoutes(
        router,
        createGitHubRepositoryService({
          authorization: createAuthorizationPolicy({}),
          store: memory.store,
          apps: appStore(),
          directory: createGitHubAppDirectory({ retryAfterBaseMs: 1 }),
          agents: {
            async get(_workspaceId, agentId) {
              const profile =
                agentId === AGENT
                  ? "op_open_v1"
                  : agentId === LISTED_AGENT
                    ? "op_closed_v1"
                    : null;
              return profile === null
                ? null
                : ({
                    active_release: { runtime_profile_id: profile },
                  } as unknown as AgentDetail);
            },
          },
          catalog: {
            profiles: {},
            installation: new Map([
              ceiling("op_open_v1", "installed"),
              ceiling("op_closed_v1", "listed"),
            ]),
          },
          fileRepositories: {
            // A credentialed entry: shown read-only and its id reserved.
            tool: {
              url: "https://github.com/acme/tool.git",
              branch: "main",
              auth: {
                kind: "basic",
                username: "x-access-token",
                password: { kind: "env", name: "TOOL_TOKEN" },
              },
            },
            // A registered-App entry is the database's now.
            seeded: {
              url: "https://github.com/acme/seeded.git",
              branch: "main",
              auth: { kind: "github_app", registered: true },
            },
          } as never,
          changed: async () => {
            changes += 1;
          },
        }),
      ),
  });
  return async (
    method: "GET" | "POST" | "PATCH",
    path: string,
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
    } = {},
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(request.cookie ? { Cookie: request.cookie } : {}),
        ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        ...(request.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

const workspacePath = (suffix = "", workspaceId = WORKSPACE) =>
  `/v1/workspaces/${workspaceId}/github-repositories${suffix}`;
const agentPath = (agentId = AGENT, query = "") =>
  `/v1/agents/${agentId}/github/repositories${query}`;

let call: ReturnType<typeof appWith>;
const ids = new Map<string, number>();
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: APP_ID,
    publicKey: keys.publicKey,
    installationId: INSTALLATION,
  });
  for (const name of ["App", "other", "tool"]) {
    await github.createRepository("acme", name, { "README.md": "hi\n" });
  }
  call = appWith();
  const listed = listGitHubRepositoriesResponseSchema.parse(
    (await call("GET", workspacePath(), { cookie: cookieFor("owner") })).json,
  );
  for (const repository of listed.repositories) {
    ids.set(repository.full_name, repository.github_repository_id);
  }
});
afterAll(async () => {
  await github.stop();
});

const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;
const idOf = (fullName: string) => {
  const id = ids.get(fullName);
  if (id === undefined) throw new Error(`fake GitHub lists no ${fullName}`);
  return id;
};
const bodyFor = (method: "GET" | "POST" | "PATCH") =>
  method === "POST"
    ? { installation_id: INSTALLATION, github_repository_id: 1 }
    : method === "PATCH"
      ? { branch: "main", version: 1 }
      : undefined;

describe("the GitHub repository API", () => {
  test("an owner reads the App's repositories a page at a time with the catalog beside them", async () => {
    const owner = cookieFor("owner");
    const first = listGitHubRepositoriesResponseSchema.parse(
      (await call("GET", workspacePath("?per_page=2"), { cookie: owner })).json,
    );
    expect(first).toMatchObject({
      installations: [
        {
          id: INSTALLATION,
          account: "acme",
          connection_id: "app-row",
          role: "author",
          repository_count: 3,
        },
      ],
      installation_id: INSTALLATION,
      page: 1,
      per_page: 2,
      total_count: 3,
      unavailable: null,
    });
    expect(first.repositories.map((r) => r.full_name)).toEqual([
      "acme/App",
      "acme/other",
    ]);
    expect(first.repositories[0]).toMatchObject({
      default_branch: "main",
      catalog_id: null,
      agent_count: 0,
    });
    const second = listGitHubRepositoriesResponseSchema.parse(
      (
        await call(
          "GET",
          workspacePath(`?installation_id=${INSTALLATION}&page=2&per_page=2`),
          { cookie: owner },
        )
      ).json,
    );
    // The file's credentialed entry holds acme/tool already.
    expect(second.repositories).toEqual([
      expect.objectContaining({ full_name: "acme/tool", catalog_id: "tool" }),
    ]);
    expect(second.catalog).toEqual([
      expect.objectContaining({ id: "tool", source: "file", editable: false }),
    ]);

    const elsewhere = await call("GET", workspacePath("?installation_id=5"), {
      cookie: owner,
    });
    expect(elsewhere.status).toBe(404);
    expect(code(elsewhere.json).details).toEqual({
      reason_code: "installation_not_found",
    });
    const elsewhereForAgent = await call(
      "GET",
      agentPath(AGENT, "?installation_id=5"),
      { cookie: owner },
    );
    expect(elsewhereForAgent.status).toBe(404);
    expect(code(elsewhereForAgent.json).details).toEqual({
      reason_code: "installation_not_found",
    });
    for (const bad of ["?per_page=101", "?page=0", "?installation_id=x"]) {
      expect(
        (await call("GET", workspacePath(bad), { cookie: owner })).status,
        bad,
      ).toBe(400);
    }
  });

  test("a manager picks a repository for the agent: one catalog id, one receipt", async () => {
    const owner = cookieFor("owner");
    const page = listAgentGitHubRepositoriesResponseSchema.parse(
      (await call("GET", agentPath(), { cookie: owner })).json,
    );
    expect(page.unavailable).toBeNull();
    expect(page.total_count).toBe(3);

    const body = {
      installation_id: INSTALLATION,
      github_repository_id: idOf("acme/App"),
    };
    const picked = await call("POST", agentPath(), { cookie: owner, body });
    expect(picked.status).toBe(200);
    const first = pickAgentGitHubRepositoryResponseSchema.parse(picked.json);
    expect(first.catalog_id).toBe("app");
    expect(first.receipt_id).not.toBeNull();
    expect(memory.receipts.at(-1)).toEqual({
      operation: "resolve_repository",
      id: "app",
      receipt: first.receipt_id ?? "",
    });
    // The URL and branch are GitHub's.
    expect(memory.rows.get("app")).toMatchObject({
      url: "https://github.com/acme/App.git",
      branch: "main",
      source: "selection",
    });
    expect(changes).toBeGreaterThan(0);

    const again = pickAgentGitHubRepositoryResponseSchema.parse(
      (await call("POST", agentPath(), { cookie: owner, body })).json,
    );
    expect(again).toEqual({ catalog_id: "app", receipt_id: null });

    memory.counts.set("app", { author: 2, reviewer: 1 });
    const listed = listGitHubRepositoriesResponseSchema.parse(
      (await call("GET", workspacePath(), { cookie: owner })).json,
    );
    expect(
      listed.repositories.find((r) => r.full_name === "acme/App"),
    ).toMatchObject({ catalog_id: "app", agent_count: 2 });
    expect(listed.catalog.find((r) => r.id === "app")).toMatchObject({
      source: "selection",
      editable: true,
      installed: true,
      agent_count: 2,
    });
  });

  test("a pick outside the installation, a file entry's repository or a listed ceiling is refused", async () => {
    const owner = cookieFor("owner");
    const absent = await call("POST", agentPath(), {
      cookie: owner,
      body: { installation_id: INSTALLATION, github_repository_id: 999_999 },
    });
    expect(absent.status).toBe(400);
    expect(code(absent.json).details).toEqual({ reason_code: "not_installed" });
    // Another App's installation: GitHub would refuse its token as if down.
    const foreign = await call("POST", agentPath(), {
      cookie: owner,
      body: { installation_id: 5, github_repository_id: idOf("acme/other") },
    });
    expect(foreign.status).toBe(400);
    expect(code(foreign.json).details).toEqual({
      reason_code: "not_installed",
    });

    const file = await call("POST", agentPath(), {
      cookie: owner,
      body: {
        installation_id: INSTALLATION,
        github_repository_id: idOf("acme/tool"),
      },
    });
    expect(file.status).toBe(400);
    expect(code(file.json).details).toEqual({
      reason_code: "file_repository",
    });

    expect(
      listAgentGitHubRepositoriesResponseSchema.parse(
        (await call("GET", agentPath(LISTED_AGENT), { cookie: owner })).json,
      ),
    ).toMatchObject({ repositories: [], unavailable: "ceiling_listed" });
    const listed = await call("POST", agentPath(LISTED_AGENT), {
      cookie: owner,
      body: {
        installation_id: INSTALLATION,
        github_repository_id: idOf("acme/other"),
      },
    });
    expect(listed.status).toBe(400);
    expect(code(listed.json).details).toEqual({
      reason_code: "repository_not_allowed",
    });
    const huge = "x".repeat(REQUEST_BODY_MAX_BYTES + 1);
    expect(
      (await call("POST", agentPath(), { cookie: owner, body: { huge } }))
        .status,
    ).toBe(413);
    expect(
      (
        await call("POST", agentPath(), {
          cookie: owner,
          body: { installation_id: INSTALLATION },
        })
      ).status,
    ).toBe(400);
  });

  test("an owner changes a resolved row's branch; a file entry and bad branches are refused", async () => {
    const owner = cookieFor("owner");
    const branch = await call("PATCH", workspacePath("/app"), {
      cookie: owner,
      body: { branch: "develop", version: 1 },
    });
    expect(branch.status).toBe(200);
    expect(
      githubRepositoryWriteResponseSchema.parse(branch.json).repository,
    ).toMatchObject({ branch: "develop", version: 2, installed: true });

    const stale = await call("PATCH", workspacePath("/app"), {
      cookie: owner,
      body: { branch: "main", version: 1 },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json).code).toBe("REVISION_CONFLICT");

    const file = await call("PATCH", workspacePath("/tool"), {
      cookie: owner,
      body: { branch: "x", version: 1 },
    });
    expect(file.status).toBe(400);
    expect(code(file.json).details).toEqual({ reason_code: "file_repository" });

    for (const bad of [
      "",
      "-x",
      "a..b",
      "has space",
      "end/",
      "nul\u0000",
      "a@{1}",
      "/lead",
      "a//b",
      "a/.hidden",
      ".dot",
    ]) {
      const refused = await call("PATCH", workspacePath("/app"), {
        cookie: owner,
        body: { branch: bad, version: 2 },
      });
      expect(refused.status, bad).toBe(400);
    }
    const huge = "x".repeat(REQUEST_BODY_MAX_BYTES + 1);
    expect(
      (
        await call("PATCH", workspacePath("/app"), {
          cookie: owner,
          body: { branch: huge },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call("PATCH", workspacePath("/missing"), {
          cookie: owner,
          body: { branch: "main", version: 1 },
        })
      ).status,
    ).toBe(404);
  });

  test("without the author App the pages say so and a pick is refused", async () => {
    const owner = cookieFor("owner");
    appRegistered = false;
    try {
      const listed = listGitHubRepositoriesResponseSchema.parse(
        (await call("GET", workspacePath(), { cookie: owner })).json,
      );
      expect(listed).toMatchObject({
        installations: [],
        installation_id: null,
        repositories: [],
        unavailable: "no_author_app",
      });
      expect(listed.catalog.find((r) => r.id === "app")?.installed).toBe(null);
      const pick = await call("POST", agentPath(), {
        cookie: owner,
        body: {
          installation_id: INSTALLATION,
          github_repository_id: idOf("acme/other"),
        },
      });
      expect(pick.status).toBe(400);
      expect(code(pick.json).details).toEqual({ reason_code: "no_author_app" });
    } finally {
      appRegistered = true;
    }
  });

  test("GitHub failing is an error by cause, never an empty page", async () => {
    const owner = cookieFor("owner");
    const pickBody = {
      installation_id: INSTALLATION,
      github_repository_id: idOf("acme/other"),
    };
    const reads = [
      ["GET", workspacePath()],
      ["GET", agentPath()],
      ["POST", agentPath()],
    ] as const;
    for (const [status, reason] of [
      [401, "github_app_auth_failed"],
      [500, "github_unavailable"],
    ] as const) {
      github.failApp(status);
      try {
        for (const [method, path] of reads) {
          const failed = await call(method, path, {
            cookie: owner,
            ...(method === "POST" ? { body: pickBody } : {}),
          });
          expect(failed.status, `${method} ${path} ${status}`).toBe(502);
          expect(code(failed.json)).toMatchObject({
            code: "GITHUB_UNAVAILABLE",
            details: { reason_code: reason },
          });
        }
      } finally {
        github.failApp(undefined);
      }
    }

    github.suspendInstallations(true);
    try {
      for (const path of [workspacePath(), agentPath()]) {
        const suspended = await call("GET", path, { cookie: owner });
        expect(suspended.status, path).toBe(409);
        expect(code(suspended.json)).toMatchObject({
          code: "INSTALLATION_SUSPENDED",
          details: { reason_code: "installation_suspended" },
        });
      }
    } finally {
      github.suspendInstallations(false);
    }
  });

  test("250 repositories come in three pages of GitHub's own count", async () => {
    const many = await startFakeGitHub({
      appId: APP_ID,
      publicKey: keys.publicKey,
      installationId: INSTALLATION,
    });
    const served = github;
    try {
      for (let n = 0; n < 250; n += 1) {
        await many.createRepository("acme", `r${String(n).padStart(3, "0")}`, {
          "README.md": "hi\n",
        });
      }
      github = many;
      const owner = cookieFor("owner");
      const pages = [];
      for (const page of [1, 2, 3]) {
        pages.push(
          listGitHubRepositoriesResponseSchema.parse(
            (
              await call("GET", workspacePath(`?page=${page}&per_page=100`), {
                cookie: owner,
              })
            ).json,
          ),
        );
      }
      expect(pages.map((p) => p.repositories.length)).toEqual([100, 100, 50]);
      expect(pages.map((p) => p.total_count)).toEqual([250, 250, 250]);
      expect(pages[2]?.repositories.at(-1)?.full_name).toBe("acme/r249");
      expect(
        new Set(pages.flatMap((p) => p.repositories.map((r) => r.full_name)))
          .size,
      ).toBe(250);
      expect(pages[0]?.installations[0]?.repository_count).toBe(250);
    } finally {
      github = served;
      await many.stop();
    }
  }, 60_000);

  test("members, API keys and other workspaces are refused", async () => {
    const member = cookieFor("member");
    const routes = [
      ["GET", workspacePath()],
      ["PATCH", workspacePath("/app")],
      ["GET", agentPath()],
      ["POST", agentPath()],
    ] as const;
    for (const [method, path] of routes) {
      const body = bodyFor(method);
      const refused = await call(method, path, { cookie: member, body });
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect((await call(method, path, { body })).status).toBe(401);
    }
    // A key never manages the workspace's repositories or picks one.
    for (const [method, path] of [routes[0], routes[1], routes[3]]) {
      expect(
        (await call(method, path, { key: true, body: bodyFor(method) })).status,
        `${method} ${path} key`,
      ).toBe(403);
    }
    expect(
      (
        await call("GET", workspacePath("", OTHER_WORKSPACE), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("GET", agentPath(crypto.randomUUID()), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", agentPath(crypto.randomUUID()), {
          cookie: cookieFor("owner"),
          body: { installation_id: 1, github_repository_id: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("GET", agentPath(AGENT, "?per_page=0"), {
          cookie: cookieFor("owner"),
        })
      ).status,
    ).toBe(400);
  });
});

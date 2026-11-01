import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  githubRepositoryWriteResponseSchema,
  listGitHubRepositoriesResponseSchema,
  listGitHubRepositoryCandidatesResponseSchema,
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
const APP_ID = 4242;

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

// The Postgres store's locking, numbering and in-use checks are its own
// integration test; this one keeps what the routes need.
function memoryRepositories() {
  const rows = new Map<string, CatalogRepositoryRow & { removed: boolean }>();
  const receipts: Array<{ operation: string; id: string; receipt: string }> =
    [];
  const inUse = new Set<string>();
  const active = () => [...rows.values()].filter((row) => !row.removed);
  const store: CatalogRepositoryStore = {
    async listActive() {
      return active().map(({ removed: _, ...row }) => row);
    },
    async seed() {
      return [];
    },
    async add(input) {
      if (
        active().some(
          (row) => row.github_repository_id === input.githubRepositoryId,
        )
      ) {
        return { outcome: "already_added" };
      }
      const free = (id: string) => !rows.has(id) && !input.reserved.has(id);
      let id: string;
      if ("exact" in input.id) {
        if (!free(input.id.exact)) return { outcome: "id_taken" };
        id = input.id.exact;
      } else {
        id = input.id.base;
        for (let n = 2; !free(id); n += 1) id = `${input.id.base}-${n}`;
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
        source: "console" as const,
        version: 1,
        created_at: at,
        updated_at: at,
      };
      rows.set(id, { ...row, removed: false });
      receipts.push({
        operation: "add_repository",
        id,
        receipt: input.receiptId,
      });
      return { outcome: "stored", repository: row };
    },
    async setBranch(input) {
      const row = rows.get(input.id);
      if (row === undefined || row.removed) return { outcome: "not_found" };
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
      const { removed: _, ...view } = row;
      return { outcome: "stored", repository: view };
    },
    async remove(input) {
      const row = rows.get(input.id);
      if (row === undefined || row.removed) return { outcome: "not_found" };
      if (inUse.has(input.id)) {
        return { outcome: "in_use", profiles: ["default"], agents: [] };
      }
      row.removed = true;
      receipts.push({
        operation: "remove_repository",
        id: input.id,
        receipt: input.receiptId,
      });
      return { outcome: "removed" };
    },
  };
  return { store, receipts, inUse };
}

const logs = new MemoryLogSink();
const memory = memoryRepositories();
let changes = 0;

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
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    request: {
      cookie?: string;
      key?: boolean;
      body?: unknown;
      workspaceId?: string;
    } = {},
  ) => {
    const response = await app.request(
      `/v1/workspaces/${request.workspaceId ?? WORKSPACE}/github-repositories${path}`,
      {
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
      },
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

let call: ReturnType<typeof appWith>;
let appRepositoryId: number;
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: APP_ID,
    publicKey: keys.publicKey,
    installationId: 77,
  });
  await github.createRepository("acme", "App", { "README.md": "hi\n" });
  await github.createRepository("acme", "other", { "README.md": "hi\n" });
  call = appWith();
  const listed = listGitHubRepositoryCandidatesResponseSchema.parse(
    (await call("GET", "/candidates", { cookie: cookieFor("owner") })).json,
  );
  const app = listed.candidates.find((c) => c.full_name === "acme/App");
  if (app === undefined) throw new Error("fake GitHub lists no acme/App");
  appRepositoryId = app.github_repository_id;
});
afterAll(async () => {
  await github.stop();
});

const code = (json: unknown) => apiErrorResponseSchema.parse(json).error;

describe("the GitHub repository API", () => {
  test("an owner lists candidates, adds one, changes its branch and removes it", async () => {
    const owner = cookieFor("owner");
    const candidates = listGitHubRepositoryCandidatesResponseSchema.parse(
      (await call("GET", "/candidates", { cookie: owner })).json,
    );
    expect(candidates.unavailable).toBeNull();
    expect(candidates.candidates.map((c) => c.full_name)).toEqual([
      "acme/App",
      "acme/other",
    ]);
    expect(candidates.candidates[0]).toMatchObject({
      github_repository_id: appRepositoryId,
      account: "acme",
      default_branch: "main",
      catalog_id: null,
    });

    const added = await call("POST", "", {
      cookie: owner,
      body: { github_repository_id: appRepositoryId },
    });
    expect(added.status).toBe(201);
    const write = githubRepositoryWriteResponseSchema.parse(added.json);
    // The URL and branch are GitHub's, the id the name in lower case.
    expect(write.repository).toMatchObject({
      id: "app",
      full_name: "acme/App",
      url: "https://github.com/acme/App.git",
      branch: "main",
      source: "console",
      editable: true,
      version: 1,
      installed: true,
    });
    expect(memory.receipts.at(-1)).toEqual({
      operation: "add_repository",
      id: "app",
      receipt: write.receipt_id,
    });
    expect(changes).toBeGreaterThan(0);

    const listed = listGitHubRepositoriesResponseSchema.parse(
      (await call("GET", "", { cookie: owner })).json,
    );
    expect(
      listed.repositories.map(({ id, source, editable }) => ({
        id,
        source,
        editable,
      })),
    ).toEqual([
      { id: "app", source: "console", editable: true },
      { id: "tool", source: "file", editable: false },
    ]);

    const again = await call("POST", "", {
      cookie: owner,
      body: { github_repository_id: appRepositoryId },
    });
    expect(again.status).toBe(400);
    expect(code(again.json).details).toEqual({ reason_code: "already_added" });

    const branch = await call("PATCH", "/app", {
      cookie: owner,
      body: { branch: "develop", version: 1 },
    });
    expect(branch.status).toBe(200);
    expect(
      githubRepositoryWriteResponseSchema.parse(branch.json).repository,
    ).toMatchObject({ branch: "develop", version: 2 });

    const stale = await call("PATCH", "/app", {
      cookie: owner,
      body: { branch: "main", version: 1 },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json).code).toBe("REVISION_CONFLICT");

    memory.inUse.add("app");
    const held = await call("DELETE", "/app", { cookie: owner });
    expect(held.status).toBe(409);
    expect(code(held.json)).toMatchObject({
      code: "REPOSITORY_IN_USE",
      details: { installation_profiles: ["default"], agents: [] },
    });
    memory.inUse.delete("app");

    const removed = await call("DELETE", "/app", { cookie: owner });
    expect(removed.status).toBe(200);
    expect((await call("DELETE", "/app", { cookie: owner })).status).toBe(404);
  });

  test("an id the operator's file holds, or one in use, is not handed out", async () => {
    const owner = cookieFor("admin");
    const others = listGitHubRepositoryCandidatesResponseSchema
      .parse((await call("GET", "/candidates", { cookie: owner })).json)
      .candidates.find((c) => c.full_name === "acme/other");
    if (others === undefined) throw new Error("candidate missing");
    const taken = await call("POST", "", {
      cookie: owner,
      body: { github_repository_id: others.github_repository_id, id: "tool" },
    });
    expect(taken.status).toBe(400);
    expect(code(taken.json).details).toEqual({ reason_code: "id_taken" });

    // `app` was removed above: its id is still never reused.
    const numbered = await call("POST", "", {
      cookie: owner,
      body: { github_repository_id: appRepositoryId },
    });
    expect(
      githubRepositoryWriteResponseSchema.parse(numbered.json).repository.id,
    ).toBe("app-2");
  });

  test("a repository the App cannot reach, a file entry and bad bodies are refused", async () => {
    const owner = cookieFor("owner");
    const absent = await call("POST", "", {
      cookie: owner,
      body: { github_repository_id: 999_999 },
    });
    expect(absent.status).toBe(400);
    expect(code(absent.json).details).toEqual({ reason_code: "not_installed" });

    const file = await call("PATCH", "/tool", {
      cookie: owner,
      body: { branch: "x", version: 1 },
    });
    expect(file.status).toBe(400);
    expect(code(file.json).details).toEqual({ reason_code: "file_repository" });
    expect((await call("DELETE", "/tool", { cookie: owner })).status).toBe(400);

    for (const branch of ["", "-x", "a..b", "has space", "end/"]) {
      const bad = await call("PATCH", "/app-2", {
        cookie: owner,
        body: { branch, version: 1 },
      });
      expect(bad.status, branch).toBe(400);
    }
    const huge = "x".repeat(REQUEST_BODY_MAX_BYTES + 1);
    expect(
      (await call("POST", "", { cookie: owner, body: { id: huge } })).status,
    ).toBe(413);
    expect(
      (await call("PATCH", "/app-2", { cookie: owner, body: { branch: huge } }))
        .status,
    ).toBe(413);
    const badId = await call("POST", "", {
      cookie: owner,
      body: { github_repository_id: appRepositoryId, id: "Bad Id" },
    });
    expect(badId.status).toBe(400);
    expect(
      (
        await call("PATCH", "/missing", {
          cookie: owner,
          body: { branch: "main", version: 1 },
        })
      ).status,
    ).toBe(404);
  });

  test("without the author App the candidates say so and adding is refused", async () => {
    const owner = cookieFor("owner");
    appRegistered = false;
    try {
      expect(
        listGitHubRepositoryCandidatesResponseSchema.parse(
          (await call("GET", "/candidates", { cookie: owner })).json,
        ),
      ).toEqual({ candidates: [], unavailable: "no_author_app" });
      const listed = listGitHubRepositoriesResponseSchema.parse(
        (await call("GET", "", { cookie: owner })).json,
      );
      expect(listed.repositories.find((r) => r.id === "app-2")?.installed).toBe(
        null,
      );
      const add = await call("POST", "", {
        cookie: owner,
        body: { github_repository_id: appRepositoryId },
      });
      expect(add.status).toBe(400);
      expect(code(add.json).details).toEqual({ reason_code: "no_author_app" });
    } finally {
      appRegistered = true;
    }
  });

  test("members, API keys and other workspaces are refused", async () => {
    const member = cookieFor("member");
    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/candidates"],
      ["POST", ""],
      ["PATCH", "/app-2"],
      ["DELETE", "/app-2"],
    ] as const) {
      const body =
        method === "POST"
          ? { github_repository_id: appRepositoryId }
          : method === "PATCH"
            ? { branch: "main", version: 1 }
            : undefined;
      const refused = await call(method, path, { cookie: member, body });
      expect(refused.status, `${method} ${path}`).toBe(403);
      const keyed = await call(method, path, { key: true, body });
      expect(keyed.status, `${method} ${path} key`).toBe(403);
      const elsewhere = await call(method, path, {
        cookie: cookieFor("owner"),
        workspaceId: OTHER_WORKSPACE,
        body,
      });
      expect(elsewhere.status, `${method} ${path} other`).toBe(404);
      expect((await call(method, path, { body })).status).toBe(401);
    }
  });
});

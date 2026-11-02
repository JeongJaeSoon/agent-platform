import { describe, expect, test } from "bun:test";
import type { AgentDetail } from "@werft-ai/contracts";
import type { CatalogRepositoryStore } from "../ports/catalog-repository-store.ts";
import {
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppStore,
  type GitHubInstallationRepository,
} from "../ports/github-app-store.ts";
import {
  ceilingAppRepositories,
  profileAllowsRepository,
} from "../sessions/catalog.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createGitHubRepositoryService } from "./github-repository-service.ts";
import { callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const INSTALLATION = 77;

const caller = callerFor(
  {
    kind: "user",
    id: "019a0000-0000-7000-8000-0000000000d1",
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "web" },
  crypto.randomUUID(),
);

const repository = (
  id: number,
  name: string,
): GitHubInstallationRepository => ({
  id,
  owner: "acme",
  name,
  url: `https://github.com/acme/${name}`,
  defaultBranch: "main",
  private: false,
});

const installation = (
  id: number,
  account = "acme",
): GitHubAppInstallationView => ({
  id,
  account,
  accountType: "organization",
  accountId: 9000 + id,
  repositorySelection: "all",
  htmlUrl: null,
  permissions: { contents: "write" },
  createdAt: null,
  suspendedAt: null,
});

const apps = {
  async find() {
    return { id: "app-row" };
  },
  async credentials() {
    return [
      {
        id: "app-row",
        workspaceId: WORKSPACE,
        appId: 1,
        apiBase: "https://api.github.com",
        privateKey: "unused",
        updatedAt: new Date(),
      },
    ];
  },
} as unknown as GitHubAppStore;

function serviceWith(
  directory: Partial<GitHubAppDirectory>,
  registered: GitHubAppStore = apps,
) {
  const resolved: string[] = [];
  const store = {
    async listActive() {
      return [];
    },
    async agentCounts() {
      return new Map();
    },
    async resolve(input) {
      resolved.push(`${input.owner}/${input.name}`);
      return {
        outcome: "resolved",
        created: true,
        changed: true,
        repository: {
          id: input.base,
          github_repository_id: input.githubRepositoryId,
          owner: input.owner,
          name: input.name,
          url: input.url,
          branch: input.branch,
          profiles: null,
          source: "selection",
          version: 1,
          created_at: "",
          updated_at: "",
        },
      };
    },
  } as Partial<CatalogRepositoryStore> as CatalogRepositoryStore;
  const service = createGitHubRepositoryService({
    authorization: createAuthorizationPolicy({}),
    store,
    apps: registered,
    directory: {
      async installations() {
        return [installation(INSTALLATION)];
      },
      ...directory,
    } as GitHubAppDirectory,
    agents: {
      async get() {
        return {
          active_release: { runtime_profile_id: "op_open_v1" },
        } as unknown as AgentDetail;
      },
    },
    catalog: {
      profiles: {},
      installation: new Map([
        [
          "op_open_v1",
          {
            id: "op_open_v1",
            origin: "console",
            state: "usable",
            repository_ids: [],
            github_app_repositories: "installed",
          },
        ],
      ]),
    },
    fileRepositories: {},
    changed: async () => {},
  });
  const pick = (githubRepositoryId: number) =>
    service.pick(caller, AGENT, async () => ({
      installation_id: INSTALLATION,
      github_repository_id: githubRepositoryId,
    }));
  const list = (installationId?: number) =>
    service.list(caller, WORKSPACE, {
      installation_id: installationId,
      page: 1,
      per_page: 30,
    });
  const agentPage = () =>
    service.agentPage(caller, AGENT, { page: 1, per_page: 30 });
  return { pick, list, agentPage, resolved };
}

const credentialOf = (id: string, appId: number) => ({
  id,
  workspaceId: WORKSPACE,
  appId,
  apiBase: "https://api.github.com",
  privateKey: "pem",
  updatedAt: new Date(),
});

const twoApps = {
  async find(_workspaceId: string, role: string) {
    return { id: role === "author" ? "author-row" : "reviewer-row" };
  },
  async credentials(role: string) {
    return [
      role === "author"
        ? credentialOf("author-row", 1)
        : credentialOf("reviewer-row", 2),
    ];
  },
} as unknown as GitHubAppStore;

const failed = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => {
      if (!(error instanceof SessionServiceError)) throw error;
      return { code: error.code, details: error.details };
    },
  );

describe("the workspace's page of App installations", () => {
  test("lists the author App's installations, then the reviewer App's, with role, approval and count", async () => {
    const { list } = serviceWith(
      {
        async installations(app) {
          return app.appId === 1
            ? [installation(12, "zeta"), installation(11, "acme")]
            : [installation(21, "acme")];
        },
        async installationRepositoriesPage(_app, installationId) {
          return { repositories: [], totalCount: installationId };
        },
      },
      twoApps,
    );
    const page = await list();
    expect(page.installation_id).toBe(11);
    expect(page.installations).toEqual([
      {
        id: 11,
        account: "acme",
        connection_id: "author-row",
        role: "author",
        permissions: { contents: "write" },
        repository_count: 11,
      },
      expect.objectContaining({ id: 12, account: "zeta", role: "author" }),
      expect.objectContaining({
        id: 21,
        connection_id: "reviewer-row",
        role: "reviewer",
        repository_count: 21,
      }),
    ]);
  });

  test("an App GitHub fails for leaves the other App's installations", async () => {
    const { list } = serviceWith(
      {
        async installations(app) {
          if (app.appId === 2) throw new GitHubAppCheckError("github_rejected");
          return [installation(11, "acme")];
        },
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 1 };
        },
      },
      twoApps,
    );
    expect((await list()).installations.map(({ id }) => id)).toEqual([11]);
    expect(await failed(list(21))).toEqual({
      code: "GITHUB_UNAVAILABLE",
      details: { reason_code: "github_app_auth_failed" },
    });
  });

  test("an agent's picker reads the author App's installations only, since a pick resolves through it", async () => {
    const { agentPage } = serviceWith(
      {
        async installations(app) {
          return app.appId === 1
            ? [installation(11, "acme")]
            : [installation(21, "other")];
        },
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 0 };
        },
      },
      twoApps,
    );
    const page = await agentPage();
    expect(page.installations.map(({ id, role }) => [id, role])).toEqual([
      [11, "author"],
    ]);
  });

  test("an installation no App has is 404; a suspended one is 409", async () => {
    const { list } = serviceWith({
      async installations() {
        return [
          installation(11, "acme"),
          { ...installation(12, "zeta"), suspendedAt: new Date() },
        ];
      },
    });
    expect(await failed(list(99))).toEqual({
      code: "NOT_FOUND",
      details: { reason_code: "installation_not_found" },
    });
    expect(await failed(list(12))).toEqual({
      code: "INSTALLATION_SUSPENDED",
      details: { reason_code: "installation_suspended" },
    });
  });
});

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (!(error instanceof SessionServiceError)) throw error;
    return (error.details as { reason_code?: string } | undefined)?.reason_code;
  }
};

describe("an installed ceiling", () => {
  const ceiling = (apps: "listed" | "installed") => ({
    profiles: {},
    installation: new Map([
      [
        "c",
        {
          id: "c",
          origin: "console" as const,
          state: "usable" as const,
          repository_ids: ["named"],
          github_app_repositories: apps,
        },
      ],
    ]),
    repositories: {
      named: { url: "https://github.com/acme/named.git", branch: "main" },
      app: {
        url: "https://github.com/acme/app.git",
        branch: "main",
        github_app: true as const,
      },
      pat: { url: "https://github.com/acme/pat.git", branch: "main" },
    },
  });

  test("runs every console-App repository beside its list, and nothing else", () => {
    const installed = ceiling("installed");
    expect(profileAllowsRepository(installed, "c", "named")).toBe(true);
    expect(profileAllowsRepository(installed, "c", "app")).toBe(true);
    expect(profileAllowsRepository(installed, "c", "pat")).toBe(false);
    expect(profileAllowsRepository(installed, "c", "missing")).toBe(false);
    const listed = ceiling("listed");
    expect(profileAllowsRepository(listed, "c", "named")).toBe(true);
    expect(profileAllowsRepository(listed, "c", "app")).toBe(false);
    expect(ceilingAppRepositories(listed, "c")).toBe("listed");
    expect(ceilingAppRepositories(listed, "nope")).toBeNull();
  });
});

describe("picking a GitHub App repository for an agent", () => {
  test("a public repository the installation does not cover reads by id but is refused", async () => {
    const { pick, resolved } = serviceWith({
      async repositoryById() {
        return repository(5, "someone-elses");
      },
      // Another installation of the App, or none, covers it.
      async installationFor() {
        return { id: 99, permissions: {} };
      },
    });
    expect(await reasonOf(pick(5))).toBe("not_installed");
    expect(resolved).toEqual([]);
  });

  test("an installation the App does not have is refused before GitHub is asked for a token", async () => {
    let read = false;
    const { pick, resolved } = serviceWith({
      async installations() {
        return [installation(99)];
      },
      async repositoryById() {
        read = true;
        throw new Error(
          "GitHub refuses a token for another App's installation",
        );
      },
    });
    expect(await reasonOf(pick(5))).toBe("not_installed");
    expect(read).toBe(false);
    expect(resolved).toEqual([]);
  });

  test("a rename between the two reads is asked once more, then resolved", async () => {
    let reads = 0;
    const { pick, resolved } = serviceWith({
      async repositoryById() {
        reads += 1;
        return repository(6, reads === 1 ? "old-name" : "new-name");
      },
      async installationFor(_app, repo) {
        return repo.name === "new-name"
          ? { id: INSTALLATION, permissions: {} }
          : null;
      },
    });
    expect(await pick(6)).toEqual({
      catalog_id: "new-name",
      receipt_id: expect.any(String),
    });
    expect(reads).toBe(2);
    expect(resolved).toEqual(["acme/new-name"]);
  });

  test("GitHub failing is GITHUB_UNAVAILABLE by cause, or a vanished installation", async () => {
    for (const [thrown, code, reason] of [
      [new Error("socket hang up"), "GITHUB_UNAVAILABLE", "github_unavailable"],
      [
        new GitHubAppCheckError("github_unreachable", 502),
        "GITHUB_UNAVAILABLE",
        "github_unavailable",
      ],
      [
        new GitHubAppCheckError("github_rejected", 401),
        "GITHUB_UNAVAILABLE",
        "github_app_auth_failed",
      ],
      [
        new GitHubAppCheckError("github_rejected", 404),
        "NOT_FOUND",
        "installation_not_found",
      ],
    ] as const) {
      const { pick, resolved } = serviceWith({
        async repositoryById() {
          throw thrown;
        },
      });
      expect(await failed(pick(7))).toEqual({
        code,
        details: { reason_code: reason },
      });
      expect(resolved).toEqual([]);
    }
  });

  test("a refused App key is told apart from the App's installation list", async () => {
    const { pick } = serviceWith({
      async installations() {
        throw new GitHubAppCheckError("github_rejected", 404);
      },
    });
    expect(await failed(pick(7))).toEqual({
      code: "GITHUB_UNAVAILABLE",
      details: { reason_code: "github_app_auth_failed" },
    });
  });
});

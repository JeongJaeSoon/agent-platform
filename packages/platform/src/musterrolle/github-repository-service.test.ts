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

const installationView = (id: number): GitHubAppInstallationView => ({
  id,
  account: "acme",
  repositorySelection: "selected",
  htmlUrl: null,
  permissions: {},
  suspended: false,
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

function serviceWith(directory: Partial<GitHubAppDirectory>) {
  const resolved: string[] = [];
  const store = {
    async listActive() {
      return [];
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
    apps,
    directory: {
      async installations() {
        return [installationView(INSTALLATION)];
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
  return { pick, resolved };
}

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
        return [installationView(99)];
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
      // The token for the installation: it went away after it was listed.
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
      const failed = await pick(7).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(SessionServiceError);
      expect((failed as SessionServiceError).code).toBe(code);
      expect((failed as SessionServiceError).details).toEqual({
        reason_code: reason,
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
    const failed = (await pick(7).catch(
      (error: unknown) => error,
    )) as SessionServiceError;
    expect(failed.code).toBe("GITHUB_UNAVAILABLE");
    expect(failed.details).toEqual({ reason_code: "github_app_auth_failed" });
  });
});

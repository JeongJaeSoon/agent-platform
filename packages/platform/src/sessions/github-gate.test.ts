import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  GITHUB_CEILING_NONE,
  type GitHubAppRole,
  type GitHubCeiling,
  type GitHubFeatures,
  type GitHubRefusal,
} from "@werft-ai/contracts";
import type { GitCredential, RepoRef } from "../ports/forge.ts";
import {
  type GitHubApi,
  type GitHubConnection,
  type GitHubDispatchRecord,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGateStore,
  GitHubPermissionError,
  type GitHubPermissions,
  type GitHubSessionContext,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type { SessionCatalog } from "./catalog.ts";
import { createGitHubGate } from "./github-gate.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const STARTER = "019a0000-0000-7000-8000-0000000000b1";
const ALL_ON: GitHubCeiling = {
  workflows: true,
  actions: true,
  checks: true,
  issues: true,
  review: true,
};

const CATALOG = {
  profiles: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
    ghes: {
      url: "https://ghe.example.com/acme/app.git",
      branch: "main",
      auth: {
        kind: "github_app",
        app_id: 7,
        installation_id: 70,
        api_base: "https://ghe.example.com/api/v3",
        value: "pem",
        ref: { value_env: "GHES_APP_KEY" },
      },
    },
    gitea: {
      url: "https://gitea.example.com/acme/app.git",
      branch: "main",
      auth: { kind: "bearer", value: "static", ref: { value_env: "GITEA" } },
    },
    public: { url: "https://example.com/acme/app.git", branch: "main" },
  },
} satisfies SessionCatalog;

function features(on: Partial<GitHubFeatures> = {}): GitHubFeatures {
  return { ...GITHUB_CEILING_NONE, ...on };
}

function settings(overrides: Partial<AgentGitHub> = {}): AgentGitHub {
  return {
    repositories: ["app", "ghes"],
    push_approval: true,
    features: features(),
    actions_allow: [],
    ...overrides,
  };
}

function fakeApi(): GitHubApi {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    maxBodyLength: 65_536,
    getRepository: unused,
    findPullRequestForBranch: unused,
    createPullRequest: unused,
    getPullRequest: unused,
    updatePullRequestBody: unused,
    upsertComment: unused,
    dispatchWorkflow: unused,
    getWorkflowRun: unused,
    rerunWorkflow: unused,
    submitReview: unused,
  };
}

/** A connection with its own cache; each issued value names the connection. */
function fakeConnection(
  label: string,
  options: { kind?: "app" | "pat"; githubCom?: boolean; appId?: number } = {},
) {
  const issued: Array<{ repo: RepoRef; permissions: GitHubPermissions }> = [];
  const cache = new Map<string, GitCredential>();
  let refuse = false;
  const connection: GitHubConnection = {
    kind: options.kind ?? "app",
    githubCom: options.githubCom ?? true,
    appId: options.kind === "pat" ? null : (options.appId ?? 7),
    quotaKey: async () => `${label}:quota`,
    installed: async () => (options.kind === "pat" ? null : true),
    credential: async (repo, permissions) => {
      issued.push({ repo, permissions });
      if (refuse) throw new GitHubPermissionError("422");
      const key = JSON.stringify([repo, permissions]);
      const cached = cache.get(key);
      if (cached !== undefined) return { credential: cached, fresh: false };
      const made: GitCredential = {
        username: "x-access-token",
        password: `${label}-${cache.size + 1}`,
        expiresAt: new Date("2026-10-30T01:00:00.000Z"),
      };
      cache.set(key, made);
      return { credential: made, fresh: true };
    },
    api: () => fakeApi(),
  };
  return {
    connection,
    issued,
    refusePermissions: () => {
      refuse = true;
    },
  };
}

function harness(
  options: {
    repositoryId?: string | null;
    /** Default: the catalog entry's URL and branch. */
    repository?: { url: string; branch: string } | null;
    github?: AgentGitHub | "invalid" | null;
    githubEnabled?: boolean;
    ceiling?: GitHubCeiling;
    author?: ReturnType<typeof fakeConnection> | null;
    reviewer?: ReturnType<typeof fakeConnection> | null;
    dispatches?: GitHubDispatchRecord[];
  } = {},
) {
  const author =
    options.author === undefined ? fakeConnection("author") : options.author;
  const reviewer =
    options.reviewer === undefined
      ? fakeConnection("reviewer", { appId: 8 })
      : options.reviewer;
  const ghes = fakeConnection("ghes", { githubCom: false });
  const state = {
    repositoryId:
      options.repositoryId === undefined ? "app" : options.repositoryId,
    github: options.github === undefined ? settings() : options.github,
    githubEnabled: options.githubEnabled ?? true,
    ceiling: options.ceiling ?? GITHUB_CEILING_NONE,
  };
  const pinned =
    state.repositoryId !== null &&
    Object.hasOwn(CATALOG.repositories, state.repositoryId)
      ? CATALOG.repositories[
          state.repositoryId as keyof typeof CATALOG.repositories
        ]
      : null;
  const repository =
    options.repository !== undefined
      ? options.repository
      : pinned === null
        ? null
        : { url: pinned.url, branch: pinned.branch };
  const receipts: GitHubGateReceipt[] = [];
  const asked: Array<{ repositoryId: string; role: GitHubAppRole }> = [];
  const store: GitHubGateStore = {
    context: async (sessionId): Promise<GitHubSessionContext | null> =>
      sessionId !== SESSION
        ? null
        : {
            ownerId: "owner-a",
            sessionId,
            repositoryId: state.repositoryId,
            repository,
            startedBy: STARTER,
            agent: {
              id: "agent-1",
              workspaceId: "owner-a",
              githubEnabled: state.githubEnabled,
            },
            release: { id: "release-1", github: state.github },
            ceiling: state.ceiling,
          },
    findDispatch: async (repositoryId, runId) =>
      (options.dispatches ?? []).find(
        (record) =>
          record.repositoryId === repositoryId && record.runId === runId,
      ) ?? null,
    recordReceipt: async (receipt) => {
      receipts.push(receipt);
      return `receipt-${receipts.length}`;
    },
  };
  const gate = createGitHubGate({
    store,
    catalog: CATALOG,
    connections: (repositoryId, role) => {
      asked.push({ repositoryId, role });
      if (repositoryId === "ghes") return ghes.connection;
      if (repositoryId !== "app") return null;
      return (role === "author" ? author : reviewer)?.connection ?? null;
    },
  });
  const grant = (work: Omit<GitHubWork, "sessionId">) =>
    gate.grant({ sessionId: SESSION, ...work });
  return { gate, grant, state, receipts, asked, author, reviewer, ghes };
}

async function refused(
  promise: Promise<unknown>,
): Promise<{ reason: GitHubRefusal; receiptId: string | null }> {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GitHubGateError);
  const { reasonCode, receiptId } = error as GitHubGateError;
  return { reason: reasonCode, receiptId };
}

describe("permission table", () => {
  test("clone asks contents:read from the author App", async () => {
    const { grant, author } = harness();
    const granted = await grant({ purpose: "clone" });
    expect(granted).toMatchObject({
      role: "author",
      repo: { owner: "acme", name: "app" },
      permissions: { contents: "read" },
      allowedBy: null,
    });
    expect(author?.issued.map((call) => call.permissions)).toEqual([
      { contents: "read" },
    ]);
  });

  test("push asks contents:write, plus workflows:write when workflows is on under the ceiling", async () => {
    const plain = harness();
    expect((await plain.grant({ purpose: "push" }))?.permissions).toEqual({
      contents: "write",
    });
    const withWorkflows = harness({
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    expect(
      (await withWorkflows.grant({ purpose: "push" }))?.permissions,
    ).toEqual({ contents: "write", workflows: "write" });
  });

  test("push drops workflows:write when workflows is over the ceiling, and is not refused", async () => {
    const { grant, receipts } = harness({
      github: settings({ features: features({ workflows: true }) }),
      ceiling: GITHUB_CEILING_NONE,
    });
    expect((await grant({ purpose: "push" }))?.permissions).toEqual({
      contents: "write",
    });
    expect(receipts.map((receipt) => receipt.status)).toEqual(["succeeded"]);
  });

  test("pull_request asks contents:read and pull_requests:write", async () => {
    const { grant } = harness();
    expect((await grant({ purpose: "pull_request" }))?.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
    });
  });

  test("actions_read asks actions:read", async () => {
    const { grant } = harness({
      github: settings({ features: features({ actions: true }) }),
      ceiling: ALL_ON,
    });
    expect((await grant({ purpose: "actions_read" }))?.permissions).toEqual({
      actions: "read",
    });
  });

  test("dispatch and rerun ask actions:write", async () => {
    const { grant } = harness({
      github: settings({
        features: features({ actions: true }),
        actions_allow: [{ workflow: "ci.yml" }],
      }),
      ceiling: ALL_ON,
      dispatches: [
        { runId: 5, repositoryId: "app", workflow: "ci.yml", ref: "main" },
      ],
    });
    const dispatched = await grant({
      purpose: "dispatch",
      workflow: { file: "ci.yml", ref: "main" },
    });
    expect(dispatched).toMatchObject({
      permissions: { actions: "write" },
      allowedBy: { workflow: "ci.yml" },
    });
    expect((await grant({ purpose: "rerun", runId: 5 }))?.permissions).toEqual({
      actions: "write",
    });
  });

  test("review takes the reviewer App's credential", async () => {
    const { grant, author, reviewer, receipts } = harness({
      github: settings({ features: features({ review: true }) }),
      ceiling: ALL_ON,
    });
    const granted = await grant({ purpose: "review" });
    expect(granted).toMatchObject({
      role: "reviewer",
      permissions: { contents: "read", pull_requests: "write" },
    });
    expect(granted?.gitCredential.password).toBe("reviewer-1");
    expect(author?.issued).toEqual([]);
    expect(reviewer?.issued).toHaveLength(1);
    expect(receipts[0]?.result).toMatchObject({ role: "reviewer", app_id: 8 });
  });

  test("a refused review is a review_pull_request receipt naming the pull request and commit", async () => {
    const { grant, receipts, reviewer } = harness({
      github: settings({ features: features({ review: true }) }),
      ceiling: ALL_ON,
      reviewer: null,
    });
    const review = {
      number: 12,
      commitId: "a".repeat(40),
      event: "APPROVE" as const,
    };
    expect(await refused(grant({ purpose: "review", review }))).toEqual({
      reason: "no_reviewer_app",
      receiptId: "receipt-1",
    });
    expect(reviewer).toBeNull();
    expect(receipts[0]).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: {
        reason_code: "no_reviewer_app",
        number: 12,
        commit_id: "a".repeat(40),
        event: "APPROVE",
      },
    });
  });

  test("outcome_refresh asks pull_requests:read and skips switch, scope, feature and ceiling", async () => {
    const { grant } = harness({
      githubEnabled: false,
      github: settings({ repositories: ["ghes"] }),
      ceiling: GITHUB_CEILING_NONE,
    });
    expect(await grant({ purpose: "outcome_refresh" })).toMatchObject({
      role: "author",
      permissions: { pull_requests: "read" },
    });
  });
});

describe("refusals", () => {
  const cases: Array<{
    reason: GitHubRefusal;
    setup: Parameters<typeof harness>[0];
    work: Omit<GitHubWork, "sessionId">;
  }> = [
    {
      reason: "github_disabled",
      setup: { githubEnabled: false },
      work: { purpose: "clone" },
    },
    {
      reason: "repository_not_allowed",
      setup: { github: settings({ repositories: ["ghes"] }) },
      work: { purpose: "push" },
    },
    {
      reason: "feature_off",
      setup: { ceiling: ALL_ON },
      work: { purpose: "actions_read" },
    },
    {
      reason: "over_workspace_ceiling",
      setup: { github: settings({ features: features({ actions: true }) }) },
      work: { purpose: "actions_read" },
    },
    {
      reason: "no_reviewer_app",
      setup: {
        github: settings({ features: features({ review: true }) }),
        ceiling: ALL_ON,
        reviewer: null,
      },
      work: { purpose: "review" },
    },
    {
      reason: "app_required",
      setup: { author: fakeConnection("pat", { kind: "pat" }) },
      work: { purpose: "clone" },
    },
    {
      reason: "workflow_not_allowed",
      setup: {
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      },
      work: {
        purpose: "dispatch",
        workflow: { file: "deploy.yml", ref: "main" },
      },
    },
    {
      reason: "agent_ref_refused",
      setup: {
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml", ref: "*" }],
        }),
        ceiling: ALL_ON,
      },
      work: {
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: `agent/${SESSION}` },
      },
    },
    {
      reason: "run_ref_unprovable",
      setup: {
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      },
      work: { purpose: "rerun", runId: 404 },
    },
    {
      reason: "github_settings_unsupported",
      setup: { github: "invalid" },
      work: { purpose: "clone" },
    },
    {
      reason: "github_host_unsupported",
      setup: {
        repositoryId: "ghes",
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      },
      work: { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
    },
    {
      reason: "repository_none",
      setup: { repositoryId: null },
      work: { purpose: "clone" },
    },
  ];

  for (const { reason, setup, work } of cases) {
    test(`${reason}: refused with a receipt naming it, no credential issued`, async () => {
      const { grant, receipts, author, reviewer, ghes } = harness(setup);
      expect(await refused(grant(work))).toEqual({
        reason,
        receiptId: "receipt-1",
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        status: "failed",
        result: { reason_code: reason, purpose: work.purpose },
        error: { code: "GITHUB_REFUSED" },
      });
      expect(author?.issued ?? []).toEqual([]);
      expect(reviewer?.issued ?? []).toEqual([]);
      expect(ghes.issued).toEqual([]);
    });
  }

  test("app_permission_missing: GitHub refusing the permissions is a refusal with a receipt", async () => {
    const author = fakeConnection("author");
    author.refusePermissions();
    const { grant, receipts } = harness({ author });
    expect(await refused(grant({ purpose: "push" }))).toEqual({
      reason: "app_permission_missing",
      receiptId: "receipt-1",
    });
    expect(receipts[0]).toMatchObject({
      operation: "mint_github_token",
      status: "failed",
      result: { reason_code: "app_permission_missing" },
    });
  });

  test("a refusal receipt names the operation of the work: dispatch_workflow, rerun_workflow, mint_github_token", async () => {
    const off = { github: settings({ features: features() }), ceiling: ALL_ON };
    const dispatch = harness(off);
    await refused(
      dispatch.grant({
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "main" },
      }),
    );
    const rerun = harness(off);
    await refused(rerun.grant({ purpose: "rerun", runId: 5 }));
    const clone = harness({ githubEnabled: false });
    await refused(clone.grant({ purpose: "clone" }));
    expect(
      [dispatch, rerun, clone].map(({ receipts }) => [
        receipts[0]?.operation,
        receipts[0]?.result.reason_code,
      ]),
    ).toEqual([
      ["dispatch_workflow", "feature_off"],
      ["rerun_workflow", "feature_off"],
      ["mint_github_token", "github_disabled"],
    ]);
    expect(dispatch.receipts[0]?.result).toMatchObject({
      workflow: "ci.yml",
      ref: "main",
    });
    expect(rerun.receipts[0]?.result).toMatchObject({ run_id: 5 });
  });

  test("a refusal receipt names the human who started the session unless the work names an actor", async () => {
    const { grant, receipts } = harness({ githubEnabled: false });
    await refused(grant({ purpose: "clone" }));
    await refused(grant({ purpose: "push", actor: null }));
    expect(receipts.map((receipt) => receipt.actor)).toEqual([
      {
        principal: { kind: "user", id: STARTER },
        actor_user_id: STARTER,
        agent_id: null,
      },
      null,
    ]);
  });
});

describe("credentials and receipts", () => {
  test("a fresh credential writes a mint_github_token receipt and a cached one does not", async () => {
    const { grant, receipts, author } = harness();
    const first = await grant({ purpose: "clone" });
    const second = await grant({ purpose: "clone" });
    expect(second?.gitCredential).toBe(first?.gitCredential as GitCredential);
    expect(author?.issued).toHaveLength(2);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operation: "mint_github_token",
      status: "succeeded",
      error: null,
      result: {
        session_id: SESSION,
        agent_id: "agent-1",
        agent_release_id: "release-1",
        repository_id: "app",
        purpose: "clone",
        role: "author",
        app_id: 7,
        permissions: { contents: "read" },
        expires_at: "2026-10-30T01:00:00.000Z",
      },
    });
    expect(JSON.stringify(receipts)).not.toContain(
      first?.gitCredential.password ?? "?",
    );
  });

  test("the switch turned off refuses the next grant though the connection still caches a credential", async () => {
    const { grant, state, author } = harness();
    await grant({ purpose: "clone" });
    expect(author?.issued).toHaveLength(1);
    state.githubEnabled = false;
    expect((await refused(grant({ purpose: "clone" }))).reason).toBe(
      "github_disabled",
    );
    expect(author?.issued).toHaveLength(1);
  });

  test("lowering the ceiling makes the next grant over_workspace_ceiling and raising it restores it", async () => {
    const { grant, state } = harness({
      github: settings({ features: features({ actions: true }) }),
      ceiling: ALL_ON,
    });
    expect(await grant({ purpose: "actions_read" })).not.toBeNull();
    state.ceiling = GITHUB_CEILING_NONE;
    expect((await refused(grant({ purpose: "actions_read" }))).reason).toBe(
      "over_workspace_ceiling",
    );
    state.ceiling = ALL_ON;
    expect((await grant({ purpose: "actions_read" }))?.permissions).toEqual({
      actions: "read",
    });
  });
});

describe("connections", () => {
  test("a GHES repository is granted clone, push and pull_request, but dispatch is github_host_unsupported", async () => {
    const { grant, ghes } = harness({
      repositoryId: "ghes",
      github: settings({
        features: features({ actions: true }),
        actions_allow: [{ workflow: "ci.yml" }],
      }),
      ceiling: ALL_ON,
    });
    for (const purpose of ["clone", "push", "pull_request"] as const) {
      expect(await grant({ purpose })).toMatchObject({
        role: "author",
        repo: { owner: "acme", name: "app" },
      });
    }
    expect(ghes.issued).toHaveLength(3);
    expect(
      (
        await refused(
          grant({
            purpose: "dispatch",
            workflow: { file: "ci.yml", ref: "main" },
          }),
        )
      ).reason,
    ).toBe("github_host_unsupported");
    expect(ghes.issued).toHaveLength(3);
  });

  test("two repositories with the same App id and repo name on different hosts never share credentials", async () => {
    const onApp = harness();
    const onGhes = harness({ repositoryId: "ghes" });
    const fromApp = await onApp.grant({ purpose: "clone" });
    const fromGhes = await onGhes.grant({ purpose: "clone" });
    expect(fromApp?.gitCredential.password).toBe("author-1");
    expect(fromGhes?.gitCredential.password).toBe("ghes-1");
    expect(onApp.asked.map((ask) => ask.repositoryId)).toEqual(["app"]);
    expect(onGhes.asked.map((ask) => ask.repositoryId)).toEqual(["ghes"]);
    expect(onApp.ghes.issued).toEqual([]);
    expect(onGhes.author?.issued).toEqual([]);
  });

  test("a repository not on GitHub returns null and writes nothing", async () => {
    for (const repositoryId of ["gitea", "public"]) {
      const { grant, receipts } = harness({ repositoryId });
      expect(await grant({ purpose: "clone" })).toBeNull();
      expect(receipts).toEqual([]);
    }
  });

  test("a catalog entry re-pointed after the session pinned it grants nothing", async () => {
    for (const repository of [
      { url: "https://github.com/acme/other.git", branch: "main" },
      { url: "https://github.com/acme/app.git", branch: "release" },
      null,
    ]) {
      const { grant, author, receipts } = harness({
        repository,
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      });
      for (const work of [
        { purpose: "actions_read" },
        { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
        { purpose: "clone" },
      ] as const) {
        await expect(grant(work)).rejects.toThrow(
          "The session's repository moved",
        );
      }
      expect(author?.issued).toEqual([]);
      expect(receipts).toEqual([]);
    }
  });

  test("a session the store does not know is not granted", async () => {
    const { gate } = harness();
    await expect(
      gate.grant({ sessionId: OTHER_SESSION, purpose: "clone" }),
    ).rejects.toThrow("The session was not found");
  });
});

describe("workflow allow-list", () => {
  const allow = (actions_allow: AgentGitHub["actions_allow"]) =>
    harness({
      github: settings({
        features: features({ actions: true }),
        actions_allow,
      }),
      ceiling: ALL_ON,
    });

  test("a ref glob's * does not cross /", async () => {
    const { grant } = allow([{ workflow: "ci.yml", ref: "release/*" }]);
    expect(
      await grant({
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "release/1.0" },
      }),
    ).toMatchObject({ allowedBy: { workflow: "ci.yml", ref: "release/*" } });
    expect(
      (
        await refused(
          grant({
            purpose: "dispatch",
            workflow: { file: "ci.yml", ref: "release/1.0/hotfix" },
          }),
        )
      ).reason,
    ).toBe("workflow_not_allowed");
  });

  test("an entry without ref allows only the catalog entry's branch", async () => {
    const { grant } = allow([{ workflow: "ci.yml" }]);
    expect(
      await grant({
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "main" },
      }),
    ).toMatchObject({ allowedBy: { workflow: "ci.yml" } });
    expect(
      (
        await refused(
          grant({
            purpose: "dispatch",
            workflow: { file: "ci.yml", ref: "develop" },
          }),
        )
      ).reason,
    ).toBe("workflow_not_allowed");
  });

  test("a recorded run whose workflow left the allow-list is workflow_not_allowed", async () => {
    const { grant, receipts } = harness({
      github: settings({
        features: features({ actions: true }),
        actions_allow: [{ workflow: "ci.yml" }],
      }),
      ceiling: ALL_ON,
      dispatches: [
        { runId: 9, repositoryId: "app", workflow: "old.yml", ref: "main" },
      ],
    });
    expect((await refused(grant({ purpose: "rerun", runId: 9 }))).reason).toBe(
      "workflow_not_allowed",
    );
    expect(receipts[0]).toMatchObject({
      operation: "rerun_workflow",
      result: { run_id: 9, workflow: "old.yml", ref: "main" },
    });
  });
});

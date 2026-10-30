import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentGitHub,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentGitHubStore } from "../ports/agent-github-store.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { createAgentGitHubService } from "./agent-github-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const PROFILE = "claude-coding-v1";

const app = (extra: object = {}) => ({
  kind: "github_app" as const,
  registered: true as const,
  ...extra,
});
const enterprise = {
  kind: "github_app" as const,
  app_id: 1,
  installation_id: 2,
  api_base: "https://ghe.example.com/api/v3",
  value: "pem",
  ref: { value_env: "PEM" },
};

const catalog = withSeededInstallation({
  profiles: {
    [PROFILE]: {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key",
          value: "provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://github.com/acme/sample-app",
      branch: "main",
      profiles: [PROFILE],
      auth: app(),
    },
    "pat-app": {
      url: "https://github.com/acme/pat-app",
      branch: "main",
      profiles: [PROFILE],
      auth: {
        kind: "basic",
        username: "x-access-token",
        value: "pat",
        ref: { value_env: "PAT" },
      },
    },
    "elsewhere-app": {
      url: "https://github.com/acme/elsewhere",
      branch: "main",
      profiles: ["another-profile"],
      auth: app(),
    },
    "ghe-app": {
      url: "https://ghe.example.com/acme/app",
      branch: "main",
      profiles: [PROFILE],
      auth: enterprise,
    },
    "gitea-app": {
      url: "https://gitea.example.com/acme/app",
      branch: "main",
      profiles: [PROFILE],
    },
  },
} as SessionCatalog);

const ALL_ON: GitHubCeiling = {
  workflows: true,
  actions: true,
  checks: true,
  issues: true,
  review: true,
};

function serviceWith(input: {
  repository?: string | null;
  github?: AgentGitHub;
  ceiling?: GitHubCeiling;
  author?: Record<string, "read" | "write" | "admin"> | null;
  reviewer?: Record<string, "read" | "write" | "admin"> | null | "none";
  noRelease?: boolean;
  /** `<repository>:<role>` → GitHub's answer; absent: no connection. */
  installed?: Record<string, boolean | null | Error>;
}) {
  const release = input.noRelease
    ? null
    : {
        id: "sha256:release",
        runtime_profile_id: PROFILE,
        repository_id:
          input.repository === undefined ? "sample-app" : input.repository,
        policy_pins: input.github === undefined ? {} : { github: input.github },
      };
  const store: AgentGitHubStore = {
    async enabled() {
      return true;
    },
    async setEnabled() {
      return { outcome: "saved", receiptId: null };
    },
    async activity() {
      return [];
    },
  };
  return createAgentGitHubService({
    authorization: createAuthorizationPolicy(),
    agents: {
      async get() {
        return { active_release: release } as unknown as AgentDetail;
      },
    },
    store,
    catalog,
    githubSettings: {
      async get() {
        return { ceiling: input.ceiling ?? ALL_ON, revision: 1 };
      },
      async appPermissions() {
        return {
          author:
            input.author === null
              ? null
              : { permissions: input.author ?? { contents: "write" } },
          reviewer:
            input.reviewer === "none"
              ? null
              : { permissions: input.reviewer ?? { pull_requests: "write" } },
        };
      },
    },
    connections: (id, role) => {
      const answer = input.installed?.[`${id}:${role}`];
      if (answer === undefined) return null;
      return {
        kind: "app",
        githubCom: true,
        appId: 1,
        credential: async () => {
          throw new Error("not used");
        },
        api: () => {
          throw new Error("not used");
        },
        installed: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
    },
  });
}

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

const WITH_SETTINGS: AgentGitHub = {
  repositories: ["sample-app"],
  push_approval: true,
  features: { ...GITHUB_CEILING_NONE },
  actions_allow: [],
};

describe("the agent GitHub tab's options", () => {
  test("repositories: GitHub ones only, each with why it cannot be picked", async () => {
    const read = await serviceWith({}).get(caller, AGENT);
    const unknown = { author: null, reviewer: null };
    expect(read.options.repositories).toEqual([
      {
        id: "elsewhere-app",
        url: "https://github.com/acme/elsewhere",
        available: false,
        reason: "repository_not_allowed",
        installed: unknown,
      },
      {
        id: "ghe-app",
        url: "https://ghe.example.com/acme/app",
        available: true,
        reason: null,
        installed: unknown,
      },
      {
        id: "pat-app",
        url: "https://github.com/acme/pat-app",
        available: false,
        reason: "app_required",
        installed: unknown,
      },
      {
        id: "sample-app",
        url: "https://github.com/acme/sample-app",
        available: true,
        reason: null,
        installed: unknown,
      },
    ]);
  });

  test("installed: each role's App as GitHub answers; no connection or no answer is null", async () => {
    const read = await serviceWith({
      installed: {
        "sample-app:author": true,
        "sample-app:reviewer": false,
        "elsewhere-app:author": false,
        "elsewhere-app:reviewer": new Error("GitHub failed (502)"),
        "pat-app:author": null,
      },
    }).get(caller, AGENT);
    const installed = Object.fromEntries(
      read.options.repositories.map((entry) => [entry.id, entry.installed]),
    );
    expect(installed).toEqual({
      "elsewhere-app": { author: false, reviewer: null },
      "ghe-app": { author: null, reviewer: null },
      "pat-app": { author: null, reviewer: null },
      "sample-app": { author: true, reviewer: false },
    });
  });

  test("features: the ceiling, the reviewer App and the App's permissions, in that order", async () => {
    const read = await serviceWith({
      github: WITH_SETTINGS,
      ceiling: { ...ALL_ON, checks: false },
      author: {
        contents: "write",
        actions: "write",
        issues: "read",
        workflows: "admin",
      },
      reviewer: "none",
    }).get(caller, AGENT);
    expect(read.options.features).toEqual({
      workflows: { available: true, reason: null },
      actions: { available: true, reason: null },
      checks: { available: false, reason: "over_workspace_ceiling" },
      issues: { available: false, reason: "app_permission_missing" },
      review: { available: false, reason: "no_reviewer_app" },
    });
  });

  test("a reviewer App without pull request write is missing the permission; unread permissions are not judged", async () => {
    const lacking = await serviceWith({
      reviewer: { pull_requests: "read" },
      author: null,
    }).get(caller, AGENT);
    expect(lacking.options.features.review.reason).toBe(
      "app_permission_missing",
    );
    expect(lacking.options.features.checks.available).toBe(true);
  });

  test("only GitHub Enterprise repositories chosen: every optional permission is unsupported", async () => {
    const read = await serviceWith({
      repository: "ghe-app",
      github: { ...WITH_SETTINGS, repositories: ["ghe-app"] },
    }).get(caller, AGENT);
    for (const option of Object.values(read.options.features)) {
      expect(option).toEqual({
        available: false,
        reason: "github_host_unsupported",
      });
    }
    const mixed = await serviceWith({
      github: { ...WITH_SETTINGS, repositories: ["sample-app", "ghe-app"] },
      author: { actions: "write" },
    }).get(caller, AGENT);
    expect(mixed.options.features.actions.available).toBe(true);
  });

  test("legacy defaults: the release's repository alone, push approval on, nothing optional", async () => {
    const read = await serviceWith({}).get(caller, AGENT);
    expect(read.github).toBeNull();
    expect(read.unsavable).toBeNull();
    expect(read.legacy_defaults).toEqual(WITH_SETTINGS);
    const saved = await serviceWith({ github: WITH_SETTINGS }).get(
      caller,
      AGENT,
    );
    expect(saved.github).toEqual(WITH_SETTINGS);
    expect(saved.legacy_defaults).toBeNull();
  });

  test("why nothing can be saved: no release, no repository, a PAT repository", async () => {
    expect(
      (await serviceWith({ noRelease: true }).get(caller, AGENT)).unsavable,
    ).toBe("no_active_release");
    expect(
      (await serviceWith({ repository: null }).get(caller, AGENT)).unsavable,
    ).toBe("repository_none");
    const pat = await serviceWith({ repository: "pat-app" }).get(caller, AGENT);
    expect(pat.unsavable).toBe("app_required");
    expect(pat.legacy_defaults).toBeNull();
  });
});

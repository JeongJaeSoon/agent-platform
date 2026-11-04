import { describe, expect, test } from "bun:test";
import type { AgentGitHub } from "@werft-ai/contracts";
import {
  type AdditionalRepositoryContext,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";
import {
  environmentCredentials,
  resolveSessionCatalog,
  sessionCatalogConfigSchema,
} from "./catalog.ts";
import { withSeededInstallation } from "./profile-registry.ts";

const profile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "1",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_MAIN" },
  },
};
const repo = (name: string, profiles = ["p"]) => ({
  url: `https://github.com/acme/${name}.git`,
  branch: "main",
  profiles,
});
const catalog = withSeededInstallation(
  resolveSessionCatalog(
    sessionCatalogConfigSchema.parse({
      profiles: { p: profile, q: profile },
      repositories: {
        app: repo("app"),
        docs: repo("docs"),
        tools: repo("tools"),
        "other-profile": repo("other-profile", ["q"]),
        origin: repo("origin"),
      },
    }),
    environmentCredentials({ ANTHROPIC_KEY_MAIN: "resolved-key" }),
  ),
);

const github = (repositories: string[]): AgentGitHub => ({
  repositories,
  features: {
    workflows: false,
    actions: false,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [],
  push_approval: true,
});

const context = (
  overrides: Partial<AdditionalRepositoryContext> = {},
): AdditionalRepositoryContext => ({
  repositoryId: "app",
  profileId: "p",
  attached: null,
  policySource: "release",
  github: github(["app", "docs", "tools", "other-profile", "origin"]),
  repositoryCeiling: null,
  githubEnabled: true,
  ...overrides,
});

describe("additionalRepositoryAllowed", () => {
  test("a repository the release lists and the profile allows", () => {
    expect(additionalRepositoryAllowed(catalog, context(), "docs")).toEqual(
      expect.objectContaining({ url: "https://github.com/acme/docs.git" }),
    );
  });

  test("refuses what the release, profile, switch or name rules leave out", () => {
    const cases: Array<[Partial<AdditionalRepositoryContext>, string]> = [
      // The session's own repository is not an additional one.
      [{}, "app"],
      [{ github: github(["app"]) }, "docs"],
      [{}, "other-profile"],
      [{}, "origin"],
      [{}, "missing"],
      [{ githubEnabled: false }, "docs"],
      [{ github: null }, "docs"],
      [{ github: "invalid" }, "docs"],
      [{ profileId: null }, "docs"],
    ];
    for (const [overrides, id] of cases) {
      expect(
        additionalRepositoryAllowed(catalog, context(overrides), id),
      ).toBeNull();
    }
  });

  test("lists the allowed ones in the release's order", () => {
    expect(
      additionalRepositoriesOf(
        catalog,
        context({ github: github(["tools", "app", "docs", "origin"]) }),
      ).map(({ id }) => id),
    ).toEqual(["tools", "docs"]);
    expect(
      additionalRepositoriesOf(catalog, context({ github: null })),
    ).toEqual([]);
  });

  test("an attached list narrows the release's and never widens it", () => {
    const attachedDocs = context({ attached: ["docs"] });
    expect(additionalRepositoryAllowed(catalog, attachedDocs, "docs")).toEqual(
      expect.objectContaining({ url: "https://github.com/acme/docs.git" }),
    );
    expect(
      additionalRepositoryAllowed(catalog, attachedDocs, "tools"),
    ).toBeNull();
    expect(
      additionalRepositoriesOf(catalog, attachedDocs).map(({ id }) => id),
    ).toEqual(["docs"]);
    // Off the release's list: the attached entry no longer counts.
    const dropped = context({
      attached: ["docs", "tools"],
      github: github(["app", "tools"]),
    });
    expect(additionalRepositoryAllowed(catalog, dropped, "docs")).toBeNull();
    expect(
      additionalRepositoriesOf(catalog, dropped).map(({ id }) => id),
    ).toEqual(["tools"]);
    expect(
      additionalRepositoriesOf(catalog, context({ attached: [] })),
    ).toEqual([]);
  });
});

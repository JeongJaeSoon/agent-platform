import { describe, expect, test } from "bun:test";

import {
  type AgentGitHub,
  type AgentGitHubSettingsRow,
  effectiveGitHubPolicy,
  GITHUB_POLICY_CLOSED,
  newSessionGitHubPolicy,
} from "./agents.ts";

const PIN: AgentGitHub = {
  repositories: ["app"],
  push_approval: false,
  features: {
    workflows: false,
    actions: true,
    checks: false,
    issues: false,
    review: false,
  },
  actions_allow: [],
};

const ROW: AgentGitHubSettingsRow = {
  repositories: ["infra"],
  pushApproval: true,
  features: { ...PIN.features, actions: false },
  actionsAllow: [{ workflow: "ci.yml" }],
  startRepositoryId: "infra",
  revision: 4,
};

const SETTINGS = {
  repositories: ROW.repositories,
  push_approval: ROW.pushApproval,
  features: ROW.features,
  actions_allow: ROW.actionsAllow,
};

describe("effectiveGitHubPolicy", () => {
  const cases: Array<
    [string, Parameters<typeof effectiveGitHubPolicy>[0], unknown]
  > = [
    [
      "a release session on a release from before settings has no list",
      { source: "release", releasePin: null, agentRow: null },
      {
        source: "release",
        settings: null,
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "an absent pin reads as none, as a missing jsonb key does",
      { source: "release", releasePin: undefined, agentRow: null },
      {
        source: "release",
        settings: null,
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "a release session reads its pin",
      { source: "release", releasePin: PIN, agentRow: null },
      {
        source: "release",
        settings: PIN,
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "a release session never reads the agent's row",
      { source: "release", releasePin: PIN, agentRow: ROW },
      {
        source: "release",
        settings: PIN,
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "a pin this image cannot read is invalid",
      { source: "release", releasePin: { repositories: [] }, agentRow: null },
      {
        source: "release",
        settings: "invalid",
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "an agent session reads the agent's row, not the pin",
      { source: "agent", releasePin: PIN, agentRow: ROW },
      {
        source: "agent",
        settings: SETTINGS,
        startRepositoryId: "infra",
        agentSettingsRevision: 4,
      },
    ],
    [
      "an agent session whose row is gone is closed, not legacy",
      { source: "agent", releasePin: PIN, agentRow: null },
      {
        source: "agent",
        settings: GITHUB_POLICY_CLOSED,
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "an empty list is legal on the row",
      {
        source: "agent",
        releasePin: null,
        agentRow: { ...ROW, repositories: [], startRepositoryId: null },
      },
      {
        source: "agent",
        settings: { ...SETTINGS, repositories: [] },
        startRepositoryId: null,
        agentSettingsRevision: 4,
      },
    ],
    [
      "a row this image cannot read is invalid",
      {
        source: "agent",
        releasePin: PIN,
        agentRow: { ...ROW, features: { unknown: true } },
      },
      {
        source: "agent",
        settings: "invalid",
        startRepositoryId: null,
        agentSettingsRevision: 4,
      },
    ],
    [
      "a source this image does not know is invalid",
      { source: "team", releasePin: PIN, agentRow: ROW },
      {
        source: "agent",
        settings: "invalid",
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
    [
      "no source at all is invalid, never the release",
      { source: null, releasePin: PIN, agentRow: null },
      {
        source: "agent",
        settings: "invalid",
        startRepositoryId: null,
        agentSettingsRevision: null,
      },
    ],
  ];

  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(effectiveGitHubPolicy(input)).toEqual(expected as never);
    });
  }

  test("closed asks a person and allows nothing", () => {
    expect(GITHUB_POLICY_CLOSED.repositories).toEqual([]);
    expect(GITHUB_POLICY_CLOSED.push_approval).toBe(true);
    expect(GITHUB_POLICY_CLOSED.actions_allow).toEqual([]);
    expect(Object.values(GITHUB_POLICY_CLOSED.features)).not.toContain(true);
  });
});

describe("newSessionGitHubPolicy", () => {
  test("no row keeps today's answer: the release", () => {
    expect(newSessionGitHubPolicy(null, PIN).source).toBe("release");
    expect(newSessionGitHubPolicy(null, PIN).settings).toEqual(PIN);
    expect(newSessionGitHubPolicy(null, undefined).settings).toBeNull();
  });

  test("a row makes the session the agent's", () => {
    const policy = newSessionGitHubPolicy(ROW, PIN);
    expect(policy.source).toBe("agent");
    expect(policy.startRepositoryId).toBe("infra");
  });
});

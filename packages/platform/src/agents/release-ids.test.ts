import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  type AgentRelease,
  agentCardSchema,
  agentReleaseSchema,
} from "@werft-ai/contracts";
import {
  type CatalogProfile,
  profileFingerprint,
} from "../sessions/catalog.ts";
import {
  assertReleaseIdentity,
  cardContentSha256,
  deriveReleaseId,
  type ReleaseIdentity,
  ReleaseIdentityError,
  resolveReleaseContent,
} from "./release-ids.ts";

const AGENT_ID = "019a0000-0000-7000-8000-0000000000a1";
const VERSION_ID = "019a0000-0000-7000-8000-0000000000a2";
const USER_A = "019a0000-0000-7000-8000-0000000000b1";
const USER_B = "019a0000-0000-7000-8000-0000000000b2";

const profile: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

const card: AgentCard = agentCardSchema.parse({
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Grep", "Read"], mcp: null, forbidden: [] },
});

function identityOf(
  value: AgentCard = card,
  against: CatalogProfile = profile,
): ReleaseIdentity {
  const resolved = resolveReleaseContent(value, "coding", against);
  if (!resolved.ok) throw new Error(resolved.error.message);
  return {
    agent_id: AGENT_ID,
    card_sha256: cardContentSha256(value),
    ...resolved.content,
  };
}

function releaseOf(identity: ReleaseIdentity): AgentRelease {
  return agentReleaseSchema.parse({
    id: deriveReleaseId(identity),
    version_id: VERSION_ID,
    created_by: USER_A,
    created_at: "2026-10-11T00:00:00.000Z",
    approved_by: null,
    approved_at: null,
    ...identity,
  });
}

describe("deriveReleaseId", () => {
  test("is the same for the same input however its keys were ordered", () => {
    const identity = identityOf();
    const reordered = Object.fromEntries(
      Object.entries(identity).reverse(),
    ) as ReleaseIdentity;
    expect(deriveReleaseId(reordered)).toBe(deriveReleaseId(identity));
    expect(deriveReleaseId(identity)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const cardReordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(card).reverse())),
    ) as AgentCard;
    expect(cardContentSha256(cardReordered)).toBe(cardContentSha256(card));
  });

  test("a release stored before tool policies still hashes to its v1 id", () => {
    expect(
      deriveReleaseId({
        agent_id: AGENT_ID,
        card_sha256: "a".repeat(64),
        runtime_profile_id: "coding",
        profile_digest: `sha256:${"c".repeat(64)}`,
        runtime_config_snapshot: { model: "claude-sonnet-5", tools: ["Read"] },
        effective_tools: { tools: ["Read"], mcp: [] },
        policy_pins: {},
      }),
    ).toBe(
      "sha256:d5076011600b9dde731f137c927e17e39a8dee6a1c6a3e4d42867d6d6b68f594",
    );
  });

  test("keeps stored ids valid: changing the hashed shape needs a version bump", () => {
    expect(
      deriveReleaseId({
        agent_id: AGENT_ID,
        card_sha256: "a".repeat(64),
        runtime_profile_id: "coding",
        profile_digest: `sha256:${"c".repeat(64)}`,
        runtime_config_snapshot: { model: "claude-sonnet-5", tools: ["Read"] },
        effective_tools: { tools: ["Read"], mcp: [] },
        policy_pins: {
          tools: {
            default: { builtin: "allow", mcp: "ask" },
            per_tool: { Read: "allow" },
          },
        },
      }),
    ).toBe(
      "sha256:eddfa8338a8973b96ed536dcc05d4cbecad64de2967e0d4d16023e5d3d57e89b",
    );
  });

  test("treats array order as data", () => {
    const identity = identityOf();
    expect(
      deriveReleaseId({
        ...identity,
        effective_tools: {
          tools: [...identity.effective_tools.tools].reverse(),
          mcp: [],
        },
      }),
    ).not.toBe(deriveReleaseId(identity));
  });

  test("changes with every part of what the release runs", () => {
    const base = identityOf();
    const id = deriveReleaseId(base);
    const variants: ReleaseIdentity[] = [
      { ...base, agent_id: "019a0000-0000-7000-8000-0000000000ff" },
      { ...base, card_sha256: "b".repeat(64) },
      { ...base, runtime_profile_id: "other" },
      { ...base, profile_digest: "sha256:other" },
      {
        ...base,
        runtime_config_snapshot: { ...base.runtime_config_snapshot, x: 1 },
      },
      {
        ...base,
        policy_pins: {
          tools: {
            default: { builtin: "allow", mcp: "ask" },
            per_tool: { ...base.policy_pins.tools?.per_tool, Read: "ask" },
          },
        },
      },
    ];
    for (const variant of variants) {
      expect(deriveReleaseId(variant)).not.toBe(id);
    }
  });

  test("leaves who made or approved the release out of the id", () => {
    const release = releaseOf(identityOf());
    const approved = {
      ...release,
      created_by: USER_B,
      approved_by: USER_B,
      approved_at: "2026-10-12T00:00:00.000Z",
    };
    expect(deriveReleaseId(approved)).toBe(release.id);
    expect(() => assertReleaseIdentity(approved)).not.toThrow();
  });

  test("refuses a stored release whose content does not hash to its id", () => {
    const release = releaseOf(identityOf());
    expect(() => assertReleaseIdentity(release)).not.toThrow();
    expect(() =>
      assertReleaseIdentity({
        ...release,
        effective_tools: { tools: ["Bash"], mcp: [] },
      }),
    ).toThrow(ReleaseIdentityError);
  });
});

describe("resolveReleaseContent", () => {
  test("pins the profile digest and a snapshot without the credential", () => {
    const identity = identityOf();
    expect(identity.profile_digest).toBe(profileFingerprint(profile));
    const text = JSON.stringify(identity);
    expect(text).not.toContain("catalog-provider-key");
    expect(identity.runtime_config_snapshot).toEqual({
      model: "claude-sonnet-5",
      tools: ["Read", "Grep"],
      permission_mode: "default",
      provider: { kind: "litellm", endpoint: "https://litellm.invalid" },
    });
    expect(() => releaseOf(identity)).not.toThrow();
  });

  test("a changed profile is a different digest and so a different release", () => {
    const edited = { ...profile, permission_mode: "acceptEdits" as const };
    expect(identityOf(card, edited).profile_digest).not.toBe(
      identityOf().profile_digest,
    );
    expect(deriveReleaseId(identityOf(card, edited))).not.toBe(
      deriveReleaseId(identityOf()),
    );
    const rotated: CatalogProfile = {
      ...profile,
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key",
          value: "rotated-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
    };
    expect(deriveReleaseId(identityOf(card, rotated))).toBe(
      deriveReleaseId(identityOf()),
    );
  });

  test("keeps the profile's tool order, minus what the card forbids", () => {
    const all = identityOf(
      agentCardSchema.parse({
        ...card,
        capabilities: { tools: null, mcp: null, forbidden: ["Bash"] },
      }),
    );
    expect(all.effective_tools).toEqual({
      tools: ["Read", "Grep", "Edit"],
      mcp: [],
    });
    const none = identityOf(
      agentCardSchema.parse({
        ...card,
        capabilities: { tools: [], mcp: null, forbidden: [] },
      }),
    );
    expect(none.effective_tools.tools).toEqual([]);
  });

  test("refuses a card asking for a tool the profile does not allow", () => {
    const resolved = resolveReleaseContent(
      agentCardSchema.parse({
        ...card,
        capabilities: { tools: ["Read", "WebFetch"], mcp: null, forbidden: [] },
      }),
      "coding",
      profile,
    );
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error.field).toBe(
      "card.capabilities.tools",
    );
    expect(!resolved.ok && resolved.error.message).toContain("WebFetch");
  });

  test("pins built-in allow and MCP ask unless the card says otherwise", () => {
    expect(identityOf().policy_pins).toEqual({
      tools: {
        default: { builtin: "allow", mcp: "ask" },
        per_tool: { Read: "allow", Grep: "allow" },
      },
    });
    const declared = identityOf(
      agentCardSchema.parse({
        ...card,
        capabilities: {
          tools: ["Read", "Grep", "Bash"],
          mcp: null,
          forbidden: [],
          tool_policy: {
            default: { mcp: "deny" },
            per_tool: { Bash: "ask", Grep: "deny", mcp__docs__search: "allow" },
          },
        },
      }),
    );
    expect(declared.policy_pins).toEqual({
      tools: {
        default: { builtin: "allow", mcp: "deny" },
        per_tool: {
          Read: "allow",
          Grep: "deny",
          Bash: "ask",
          mcp__docs__search: "allow",
        },
      },
    });
  });

  test("a changed policy is a different release", () => {
    const asked = identityOf(
      agentCardSchema.parse({
        ...card,
        capabilities: {
          ...card.capabilities,
          tool_policy: { per_tool: { Read: "ask" } },
        },
      }),
    );
    expect(asked.policy_pins.tools?.per_tool.Read).toBe("ask");
    expect(deriveReleaseId(asked)).not.toBe(deriveReleaseId(identityOf()));
  });

  test("refuses a policy for a built-in tool the release does not run", () => {
    for (const capabilities of [
      { tools: ["Read"], mcp: null, forbidden: [] },
      { tools: null, mcp: null, forbidden: ["Bash"] },
    ]) {
      const resolved = resolveReleaseContent(
        agentCardSchema.parse({
          ...card,
          capabilities: {
            ...capabilities,
            tool_policy: { per_tool: { Bash: "allow" } },
          },
        }),
        "coding",
        profile,
      );
      expect(!resolved.ok && resolved.error.field).toBe(
        "card.capabilities.tool_policy.per_tool",
      );
      expect(!resolved.ok && resolved.error.message).toContain("Bash");
    }
  });

  test("refuses a card on a model the profile does not run", () => {
    const resolved = resolveReleaseContent(
      { ...card, model: "claude-opus-5" },
      "coding",
      profile,
    );
    expect(!resolved.ok && resolved.error.field).toBe("card.model");
  });
});

describe("a card naming a remote MCP server", () => {
  const servers = {
    fake: {
      url: "http://fake-mcp:4020/mcp",
      credential_ref: "mcp/fake",
      auth: {
        kind: "bearer" as const,
        value: "sa-value",
        ref: { value_env: "FAKE_MCP_SA" },
      },
      workspaces: ["default"],
    },
  };
  const mcpCard = agentCardSchema.parse({
    ...card,
    capabilities: {
      ...card.capabilities,
      mcp: [{ server: "fake" }],
      credential_refs: ["mcp/fake"],
      tool_policy: {
        per_tool: { mcp__fake__whoami: "allow", mcp__fake__other: "ask" },
      },
    },
  });
  const resolve = (value: AgentCard) =>
    resolveReleaseContent(value, "coding", profile, servers);

  test("pins the server's allowed tools, and only those", () => {
    const resolved = resolve(mcpCard);
    expect(resolved.ok && resolved.content.effective_tools).toEqual({
      tools: ["Read", "Grep"],
      mcp: ["mcp__fake__whoami"],
    });
    expect(JSON.stringify(resolved)).not.toContain("sa-value");
  });

  test("a card without one resolves as it did before the catalog had any", () => {
    expect(resolveReleaseContent(card, "coding", profile, servers)).toEqual(
      resolveReleaseContent(card, "coding", profile),
    );
  });

  test("refuses a server the catalog lacks, a credential the card does not name, or no allowed tool", () => {
    const capabilities = mcpCard.capabilities;
    for (const [value, field] of [
      [
        {
          ...mcpCard,
          capabilities: { ...capabilities, mcp: [{ server: "gone" }] },
        },
        "card.capabilities.mcp",
      ],
      [
        { ...mcpCard, capabilities: { ...capabilities, credential_refs: [] } },
        "card.capabilities.credential_refs",
      ],
      [
        {
          ...mcpCard,
          capabilities: {
            ...capabilities,
            tool_policy: { per_tool: { mcp__fake__whoami: "ask" } },
          },
        },
        "card.capabilities.tool_policy.per_tool",
      ],
    ] as const) {
      const resolved = resolve(agentCardSchema.parse(value));
      expect(!resolved.ok && resolved.error.field).toBe(field);
    }
  });
});

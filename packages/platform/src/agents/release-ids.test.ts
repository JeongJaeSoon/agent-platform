import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  type AgentRelease,
  agentCardSchema,
  agentReleaseSchema,
} from "@agent-platform/contracts";
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
    // Card keys too: the content hash is over canonical JSON.
    const cardReordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(card).reverse())),
    ) as AgentCard;
    expect(cardContentSha256(cardReordered)).toBe(cardContentSha256(card));
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
      { ...base, policy_pins: { Bash: "ask" } },
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
    // The contract's own guard agrees there is no credential in it.
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
    // Rotating the credential behind the same reference is not a change.
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

  test("refuses a card on a model the profile does not run", () => {
    const resolved = resolveReleaseContent(
      { ...card, model: "claude-opus-5" },
      "coding",
      profile,
    );
    expect(!resolved.ok && resolved.error.field).toBe("card.model");
  });
});

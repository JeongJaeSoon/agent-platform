import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { canonicalJson } from "../shared/index.ts";
import {
  type AgentCard,
  activateAgentRequestSchema,
  agentCardSchema,
  agentReleaseSchema,
  agentSchema,
  agentVersionSchema,
  createAgentRequestSchema,
  draftAgentRequestSchema,
  updateAgentRequestSchema,
} from "./agents.ts";

const AGENT_ID = "019a0000-0000-7000-8000-0000000000a1";
const VERSION_ID = "019a0000-0000-7000-8000-0000000000a2";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000a3";
const AT = "2026-09-22T01:00:00Z";

const card = {
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read", "Grep"], mcp: null, forbidden: [] },
} satisfies Record<string, unknown>;

function cardHash(value: AgentCard): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

describe("canonical JSON", () => {
  test("sorts object keys so structurally equal values hash alike", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  test("keeps array order, because order is data", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("refuses values it cannot represent the same way twice", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
    expect(() => canonicalJson(new Date(AT))).toThrow(TypeError);
    expect(() => canonicalJson({ nested: [1, undefined] })).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });

  test("refuses what JSON would drop on the floor", () => {
    // A hole serialises as `null`, so `[ , ]` and `[null]` would hash alike.
    // biome-ignore lint/suspicious/noSparseArray: that is the case under test
    expect(() => canonicalJson([, 1])).toThrow(TypeError);
    expect(() => canonicalJson(Array(1))).toThrow(TypeError);
    const withExtra = [1];
    (withExtra as unknown as Record<string, unknown>).note = "dropped";
    expect(() => canonicalJson(withExtra)).toThrow(TypeError);
    const key = Symbol("hidden");
    expect(() => canonicalJson({ a: 1, [key]: 2 })).toThrow(TypeError);
  });
});

describe("AgentCard", () => {
  test("hashes the same however the author ordered the keys", () => {
    const reordered = {
      capabilities: card.capabilities,
      model: card.model,
      instructions: card.instructions,
      role: card.role,
    };
    expect(cardHash(agentCardSchema.parse(reordered))).toBe(
      cardHash(agentCardSchema.parse(card)),
    );
  });

  test("changing any part of the card changes the hash", () => {
    const changed = { ...card, instructions: "다르게 행동한다." };
    expect(cardHash(agentCardSchema.parse(changed))).not.toBe(
      cardHash(agentCardSchema.parse(card)),
    );
    const reorderedTools = {
      ...card,
      capabilities: { ...card.capabilities, tools: ["Grep", "Read"] },
    };
    expect(cardHash(agentCardSchema.parse(reorderedTools))).not.toBe(
      cardHash(agentCardSchema.parse(card)),
    );
  });

  test("an omitted default hashes like the value spelled out", () => {
    expect(cardHash(agentCardSchema.parse({ ...card, language: "ko" }))).toBe(
      cardHash(agentCardSchema.parse(card)),
    );
    expect(
      cardHash(agentCardSchema.parse({ ...card, language: "en" })),
    ).not.toBe(cardHash(agentCardSchema.parse(card)));
  });

  test("an unset optional stays absent rather than becoming undefined", () => {
    // canonicalJson throws on undefined, so a parser that materialised the key
    // would fail the hash outright instead of quietly re-hashing every card.
    const parsed = agentCardSchema.parse(card);
    expect(Object.hasOwn(parsed, "tone")).toBe(false);
    expect(parsed.language).toBe("ko");
    expect(parsed.rules).toEqual([]);
  });

  test("has nowhere to put a credential", () => {
    expect(
      agentCardSchema.safeParse({ ...card, api_key: "sk-live-example" })
        .success,
    ).toBe(false);
    expect(
      agentCardSchema.safeParse({
        ...card,
        capabilities: { ...card.capabilities, token: "t" },
      }).success,
    ).toBe(false);
  });

  test("rejects an empty or oversized card body", () => {
    expect(
      agentCardSchema.safeParse({ ...card, instructions: "" }).success,
    ).toBe(false);
    expect(
      agentCardSchema.safeParse({ ...card, instructions: "a".repeat(20_001) })
        .success,
    ).toBe(false);
    expect(agentCardSchema.safeParse({ ...card, model: "" }).success).toBe(
      false,
    );
  });

  test("distinguishes every tool from no tool", () => {
    const all = agentCardSchema.parse({
      ...card,
      capabilities: { tools: null, mcp: null, forbidden: [] },
    });
    const none = agentCardSchema.parse({
      ...card,
      capabilities: { tools: [], mcp: [], forbidden: [] },
    });
    expect(all.capabilities.tools).toBeNull();
    expect(none.capabilities.tools).toEqual([]);
    expect(cardHash(all)).not.toBe(cardHash(none));
  });

  test("carries approved rules with their provenance", () => {
    const withRules = agentCardSchema.parse({
      ...card,
      rules: [
        { id: "r1", text: "수치는 항상 출처를 단다.", source: "correction" },
      ],
    });
    expect(withRules.rules[0]?.source).toBe("correction");
    expect(
      agentCardSchema.safeParse({
        ...card,
        rules: [{ id: "r1", text: "x", source: "model" }],
      }).success,
    ).toBe(false);
  });
});

describe("agent, version and release", () => {
  test("names the agent on the row, not inside the immutable card", () => {
    expect(Object.hasOwn(agentCardSchema.parse(card), "name")).toBe(false);
    const agent = agentSchema.parse({
      id: AGENT_ID,
      workspace_id: WORKSPACE_ID,
      slug: "finance-analyst",
      name: "재무 분석가",
      team: "finance",
      status: "active",
      active_release_id: null,
      activation_revision: 0,
      created_by: null,
      created_at: AT,
      updated_at: AT,
    });
    expect(agent.activation_revision).toBe(0);
    expect(
      agentSchema.safeParse({ ...agent, slug: "Finance Analyst" }).success,
    ).toBe(false);
    expect(agentSchema.safeParse({ ...agent, status: "deleted" }).success).toBe(
      false,
    );
  });

  test("a version pins the card by hash", () => {
    const version = agentVersionSchema.parse({
      id: VERSION_ID,
      agent_id: AGENT_ID,
      number: 1,
      card,
      card_hash: cardHash(agentCardSchema.parse(card)),
      created_by: null,
      created_at: AT,
    });
    expect(version.card_hash).toHaveLength(64);
    expect(
      agentVersionSchema.safeParse({ ...version, card_hash: "nothex" }).success,
    ).toBe(false);
    expect(
      agentVersionSchema.safeParse({ ...version, number: 0 }).success,
    ).toBe(false);
  });

  test("a release carries the resolved runtime config, never a credential value", () => {
    const release = agentReleaseSchema.parse({
      id: "rel_9f2c",
      agent_id: AGENT_ID,
      version_id: VERSION_ID,
      runtime_profile_id: "claude-coding-v1",
      runtime_profile_fingerprint: "fp_1",
      runtime_config_snapshot: {
        model: "claude-sonnet-5",
        api_key_ref: "env:KEY",
      },
      effective_tools: { tools: ["Read"], mcp: [] },
      created_at: AT,
    });
    expect(release.effective_tools.tools).toEqual(["Read"]);
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        effective_tools: { tools: [] },
      }).success,
    ).toBe(false);
  });

  test("a release snapshot has no room for a live credential", () => {
    const release = {
      id: "rel_9f2c",
      agent_id: AGENT_ID,
      version_id: VERSION_ID,
      runtime_profile_id: "claude-coding-v1",
      runtime_profile_fingerprint: "fp_1",
      runtime_config_snapshot: { model: "claude-sonnet-5" },
      effective_tools: { tools: ["Read"], mcp: [] },
      created_at: AT,
    };
    // This is the repository's own ClaudeRuntimeConfig shape: handing a
    // resolved profile straight to the release used to persist the key.
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: {
          endpoint: "https://api.anthropic.com",
          profile: { kind: "anthropic", auth: { kind: "api_key", value: "x" } },
        },
      }).success,
    ).toBe(false);
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: { headers: [{ authorization: "Bearer x" }] },
      }).success,
    ).toBe(false);
    for (const key of ["api_key", "apiKey", "secret", "private_key"]) {
      expect(
        agentReleaseSchema.safeParse({
          ...release,
          runtime_config_snapshot: { [key]: "x" },
        }).success,
      ).toBe(false);
    }
    // A reference is how a credential is meant to travel.
    expect(
      agentReleaseSchema.safeParse({
        ...release,
        runtime_config_snapshot: {
          api_key_ref: "env:ANTHROPIC_API_KEY",
          auth_kind: "api_key",
        },
      }).success,
    ).toBe(true);
  });

  test("activation is a compare-and-swap on the agent's revision", () => {
    expect(
      activateAgentRequestSchema.parse({
        version_id: VERSION_ID,
        runtime_profile_id: "claude-coding-v1",
        expected_activation_revision: 3,
      }).expected_activation_revision,
    ).toBe(3);
    expect(
      activateAgentRequestSchema.safeParse({
        version_id: VERSION_ID,
        runtime_profile_id: "claude-coding-v1",
      }).success,
    ).toBe(false);
  });

  test("request bodies stay closed and never empty", () => {
    expect(
      createAgentRequestSchema.safeParse({
        slug: "finance-analyst",
        name: "재무 분석가",
        card,
      }).success,
    ).toBe(false);
    expect(updateAgentRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ team: null }).success).toBe(
      true,
    );
    expect(draftAgentRequestSchema.safeParse({ prompt: "" }).success).toBe(
      false,
    );
  });
});

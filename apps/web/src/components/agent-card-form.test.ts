import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  AGENT_CARD_LANGUAGE_VALUES as CONTRACT_LANGUAGES,
  type ProfileSummary,
} from "@agent-platform/contracts";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  cardFromDraft,
  draftFromCard,
  EMPTY_DRAFT,
  modelOptions,
} from "./agent-card-form.tsx";

const profile = (id: string, model: string): ProfileSummary => ({
  id,
  model,
  tools: [],
  runtime_kind: "claude_agent_sdk",
  runtime_version: "1",
  billing: "none",
});

const CARD: AgentCard = {
  role: "결제 문의 담당",
  instructions: "결제 문의에 답한다.",
  tone: "공손하게",
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read", "Grep"], mcp: null, forbidden: ["Bash"] },
  rules: [],
};

describe("카드 폼 변환", () => {
  test("언어 목록은 contracts의 것이다", () => {
    expect(AGENT_CARD_LANGUAGE_VALUES).toEqual(CONTRACT_LANGUAGES);
  });

  test("카드를 폼으로 옮겼다가 되돌리면 같은 카드다", () => {
    expect<unknown>(cardFromDraft(draftFromCard(CARD), CARD)).toEqual(CARD);
  });

  test("도구 '전부'는 tools: null, 목록은 한 줄에 하나다", () => {
    const card = cardFromDraft({
      ...EMPTY_DRAFT,
      role: " 역할 ",
      model: " m ",
      toolsMode: "list",
      tools: "Read\n  Grep  \n\nWrite",
      forbidden: "",
    });
    expect<unknown>(card.capabilities).toEqual({
      tools: ["Read", "Grep", "Write"],
      mcp: null,
      forbidden: [],
    });
    expect(card.role).toBe("역할");
    expect("tone" in card).toBe(false);
    expect(
      cardFromDraft({ ...EMPTY_DRAFT, toolsMode: "all", tools: "Read" })
        .capabilities.tools,
    ).toBeNull();
  });

  test("쉼표나 공백이 든 도구 이름도 그대로 왕복한다", () => {
    const card: AgentCard = {
      ...CARD,
      capabilities: {
        tools: ["mcp__docs search", "Read"],
        mcp: null,
        forbidden: ["Bash(rm -rf, *)"],
      },
    };
    expect<unknown>(cardFromDraft(draftFromCard(card), card)).toEqual(card);
  });

  test("모델 선택지는 카탈로그의 모델을 한 번씩, 그 모델을 쓰는 profile과 함께 둔다", () => {
    const profiles = [
      profile("coding-fast", "claude-haiku-5"),
      profile("coding-local", "claude-sonnet-5"),
      profile("coding-review", "claude-sonnet-5"),
    ];
    expect(modelOptions(profiles, "")).toEqual([
      { model: "claude-haiku-5", profileIds: ["coding-fast"] },
      {
        model: "claude-sonnet-5",
        profileIds: ["coding-local", "coding-review"],
      },
    ]);
    expect(modelOptions(profiles, "claude-sonnet-5")).toHaveLength(2);
  });

  test("카탈로그에 없는 지금 모델은 profile 없는 선택지로 남는다", () => {
    expect(
      modelOptions([profile("coding-local", "claude-sonnet-5")], "gpt-x"),
    ).toEqual([
      { model: "claude-sonnet-5", profileIds: ["coding-local"] },
      { model: "gpt-x", profileIds: [] },
    ]);
    expect(modelOptions([], "gpt-x")).toEqual([
      { model: "gpt-x", profileIds: [] },
    ]);
  });

  test("편집기가 없는 rules는 원래 카드의 것을 그대로 싣는다", () => {
    const rules: AgentCard["rules"] = [
      { id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" },
    ];
    const base = { ...CARD, rules };
    expect(cardFromDraft(draftFromCard(base), base).rules).toBe(rules);
    expect(cardFromDraft(EMPTY_DRAFT).rules).toEqual([]);
  });
});

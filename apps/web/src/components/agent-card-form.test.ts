import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  AGENT_CARD_LANGUAGE_VALUES as CONTRACT_LANGUAGES,
} from "@agent-platform/contracts";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  cardFromDraft,
  draftFromCard,
  EMPTY_DRAFT,
} from "./agent-card-form.tsx";

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

  test("편집기가 없는 rules는 원래 카드의 것을 그대로 싣는다", () => {
    const rules: AgentCard["rules"] = [
      { id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" },
    ];
    const base = { ...CARD, rules };
    expect(cardFromDraft(draftFromCard(base), base).rules).toBe(rules);
    expect(cardFromDraft(EMPTY_DRAFT).rules).toEqual([]);
  });
});

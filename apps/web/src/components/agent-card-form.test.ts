import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  AGENT_CARD_LANGUAGE_VALUES as CONTRACT_LANGUAGES,
  type ProfileSummary,
} from "@werft-ai/contracts";
import {
  AGENT_CARD_LANGUAGE_VALUES,
  allowingProfiles,
  type CardDraft,
  cardDraftOf,
  cardFromDraft,
  draftFromCard,
  EMPTY_DRAFT,
  modelOptions,
  previewProfiles,
  runningProfiles,
  toolsBlocked,
} from "./agent-card-form.tsx";

const profile = (id: string, model: string): ProfileSummary => ({
  id,
  source: "operator",
  model,
  models: [model],
  tools: [],
  permission_mode: "default",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "1",
  billing: "none",
  repository_mode: "required",
});

const CARD: AgentCard = {
  role: "결제 문의 담당",
  instructions: "결제 문의에 답한다.",
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
    const withInstructions = { ...CARD, agent_instructions: "짧게 답한다." };
    expect<unknown>(
      cardFromDraft(draftFromCard(withInstructions), withInstructions),
    ).toEqual(withInstructions);
  });

  test("에이전트 지시문은 쓴 그대로 싣고, 비우면 빼며, 이전 지시 사항은 옮기지 않는다", () => {
    const typed = "  한국어로 답한다.\n";
    const card = cardFromDraft(
      { ...draftFromCard(CARD), agentInstructions: typed },
      CARD,
    );
    expect(card.agent_instructions).toBe(typed);
    expect(card.instructions).toBe(CARD.instructions);
    const cleared = cardFromDraft(
      { ...draftFromCard(card as AgentCard), agentInstructions: "  " },
      card as AgentCard,
    );
    expect("agent_instructions" in cleared).toBe(false);
    expect(draftFromCard(CARD).agentInstructions).toBe("");
  });

  test("스위치를 켜면 tools: null, 끄면 체크한 도구가 tools다", () => {
    const card = cardFromDraft({
      ...EMPTY_DRAFT,
      model: " m ",
      toolsMode: "list",
      tools: ["Read", "Grep", "Write"],
    });
    expect<unknown>(card.capabilities).toEqual({
      tools: ["Read", "Grep", "Write"],
      mcp: null,
      forbidden: [],
    });
    expect(card.model).toBe("m");
    expect(
      cardFromDraft({ ...EMPTY_DRAFT, toolsMode: "all", tools: ["Read"] })
        .capabilities.tools,
    ).toBeNull();
  });

  test("새 카드는 forbidden: []로 간다", () => {
    expect(EMPTY_DRAFT.forbidden).toEqual([]);
    expect(cardFromDraft(EMPTY_DRAFT).capabilities.forbidden).toEqual([]);
  });

  test("체크를 끈 내장 도구의 per_tool 항목은 지우고 MCP 정책은 남긴다", () => {
    const base: AgentCard = {
      ...CARD,
      capabilities: {
        tools: ["Read", "Grep"],
        mcp: null,
        forbidden: [],
        tool_policy: {
          per_tool: { Read: "allow", Grep: "ask", mcp__docs__search: "allow" },
        },
      },
    };
    const card = cardFromDraft(
      { ...draftFromCard(base), tools: ["Read"] },
      base,
    );
    expect<unknown>(card.capabilities.tool_policy).toEqual({
      per_tool: { Read: "allow", mcp__docs__search: "allow" },
    });
  });

  test("기존 forbidden은 지우기 전까지 그대로 가고, 지우면 []다", () => {
    const draft = draftFromCard(CARD);
    expect(cardFromDraft(draft, CARD).capabilities.forbidden).toEqual(["Bash"]);
    expect(
      cardFromDraft({ ...draft, forbidden: [] }, CARD).capabilities.forbidden,
    ).toEqual([]);
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

  test("편집기에 칸이 없는 필드는 칸 하나를 바꿔 저장해도 남는다", () => {
    const base: AgentCard = {
      ...CARD,
      capabilities: {
        ...CARD.capabilities,
        mcp: [{ server: "fake" }],
        tool_policy: {
          default: { mcp: "deny" },
          per_tool: { Read: "allow", Grep: "ask" },
        },
        credential_refs: ["github/app", "slack:bot"],
      },
      rules: [{ id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" }],
    };
    const draft = { ...draftFromCard(base), language: "en" as const };
    expect<unknown>(cardFromDraft(draft, base)).toEqual({
      ...base,
      language: "en",
    });
  });

  test("편집기의 칸은 모두 바꾼 값으로 저장된다", () => {
    const tool_policy = { per_tool: { Write: "ask" as const } };
    const rules: AgentCard["rules"] = [
      { id: "r1", text: "환불은 사람에게 넘긴다.", source: "user" },
    ];
    const base: AgentCard = {
      ...CARD,
      capabilities: {
        tools: null,
        mcp: null,
        forbidden: ["Bash"],
        tool_policy,
        credential_refs: ["github/app"],
      },
      rules,
    };
    const card = cardFromDraft(
      {
        agentInstructions: "새 지시",
        language: "en",
        model: "claude-haiku-5",
        toolsMode: "list",
        tools: ["Write"],
        forbidden: ["Read"],
      },
      base,
    );
    expect<unknown>(card).toEqual({
      role: CARD.role,
      instructions: CARD.instructions,
      agent_instructions: "새 지시",
      language: "en",
      model: "claude-haiku-5",
      capabilities: {
        tools: ["Write"],
        mcp: null,
        forbidden: ["Read"],
        tool_policy,
        credential_refs: ["github/app"],
      },
      rules,
    });
  });

  test("전에 저장된 한 줄에 하나 형식의 입력은 목록으로 읽고, 모양이 다르면 버린다", () => {
    expect(
      cardDraftOf({
        ...EMPTY_DRAFT,
        toolsMode: "list",
        tools: "Read\n Grep \n",
        forbidden: "Bash",
      }),
    ).toEqual({
      ...EMPTY_DRAFT,
      toolsMode: "list",
      tools: ["Read", "Grep"],
      forbidden: ["Bash"],
    });
    expect(cardDraftOf(EMPTY_DRAFT)).toEqual(EMPTY_DRAFT);
    // Input kept before the role and instructions fields left the form.
    expect(
      cardDraftOf({ ...EMPTY_DRAFT, role: "역할", instructions: "지시" }),
    ).toEqual(EMPTY_DRAFT);
    expect(cardDraftOf({ ...EMPTY_DRAFT, agentInstructions: 1 })).toBeNull();
    expect(cardDraftOf({ ...EMPTY_DRAFT, toolsMode: "some" })).toBeNull();
    expect(cardDraftOf({ ...EMPTY_DRAFT, tools: [1] })).toBeNull();
    expect(cardDraftOf("x")).toBeNull();
  });

  test("새 카드(base 없음)는 편집기 칸과 기본값만 싣고 역할·지시 사항은 없다", () => {
    expect<unknown>(cardFromDraft({ ...EMPTY_DRAFT, model: "m" })).toEqual({
      language: "ko",
      model: "m",
      capabilities: { tools: null, mcp: null, forbidden: [] },
      rules: [],
    });
  });
});

describe("미리보기 프로필과 허용 프로필 수", () => {
  const withTools = (
    id: string,
    tools: string[],
    over: Partial<ProfileSummary> = {},
  ): ProfileSummary => ({
    ...profile(id, "claude-sonnet-5"),
    repository_mode: "optional",
    tools,
    ...over,
  });
  const wide = withTools("wide", ["Read", "Edit", "Bash"]);
  const narrow = withTools("narrow", ["Read", "Edit"]);
  const required = withTools("required", ["Read", "Bash"], {
    repository_mode: "required",
  });
  const otherModel = withTools("haiku", ["Read"], {
    model: "claude-haiku-5",
    models: ["claude-haiku-5"],
  });
  const secondModel = withTools("both", ["Read"], {
    model: "claude-haiku-5",
    models: ["claude-haiku-5", "claude-sonnet-5"],
  });
  const profiles = [wide, required, otherModel, narrow, secondModel];
  const releasable = (p: ProfileSummary) => p.repository_mode !== "required";
  const draft = (over: Partial<CardDraft>): CardDraft => ({
    ...EMPTY_DRAFT,
    model: "claude-sonnet-5",
    ...over,
  });

  test("미리보기 후보는 카드 모델을 돌리는 프로필이고, 마법사는 릴리스할 수 있는 것을 먼저 둔다", () => {
    expect(
      previewProfiles(profiles, "claude-sonnet-5").map((p) => p.id),
    ).toEqual(["wide", "required", "narrow", "both"]);
    expect(
      previewProfiles(profiles, "claude-sonnet-5", releasable).map((p) => p.id),
    ).toEqual(["wide", "narrow", "both"]);
    // None it can release: the flow sends that card to the releases tab.
    expect(
      previewProfiles([required], "claude-sonnet-5", releasable).map(
        (p) => p.id,
      ),
    ).toEqual(["required"]);
  });

  test("고른 도구를 모두 허용하는 프로필만 센다", () => {
    const running = runningProfiles(profiles, "claude-sonnet-5");
    const count = (over: Partial<CardDraft>) =>
      allowingProfiles(running, draft(over)).map((p) => p.id);
    expect(count({ toolsMode: "all" })).toEqual([
      "wide",
      "required",
      "narrow",
      "both",
    ]);
    expect(count({ toolsMode: "list", tools: ["Read", "Bash"] })).toEqual([
      "wide",
      "required",
    ]);
    expect(count({ toolsMode: "list", tools: ["Read", "Edit"] })).toEqual([
      "wide",
      "narrow",
    ]);
    expect(count({ toolsMode: "list", tools: [] })).toHaveLength(4);
  });

  test("허용 프로필이 0이면 저장을 막는다", () => {
    expect(
      toolsBlocked(
        profiles,
        draft({ toolsMode: "list", tools: ["Read", "Bash"] }),
      ),
    ).toBe(false);
    // One profile runs Bash, the other Edit; none runs both.
    expect(
      toolsBlocked(
        [required, narrow],
        draft({ toolsMode: "list", tools: ["Bash", "Edit"] }),
      ),
    ).toBe(true);
    // A name no profile has, kept from an old card, blocks until unchecked.
    expect(
      toolsBlocked(profiles, draft({ toolsMode: "list", tools: ["WebFetch"] })),
    ).toBe(true);
    expect(toolsBlocked([required], draft({ toolsMode: "all" }))).toBe(false);
  });

  test("카탈로그에 없는 모델은 모델 칸이 알리고 도구로는 막지 않는다", () => {
    expect(
      toolsBlocked(
        profiles,
        draft({ model: "gpt-x", toolsMode: "list", tools: ["Read"] }),
      ),
    ).toBe(false);
  });
});

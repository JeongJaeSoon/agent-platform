import { describe, expect, test } from "bun:test";
import {
  type PendingQuestion,
  USER_LOCALE_VALUES,
  type UserLocale,
} from "@werft-ai/contracts";
import type { PendingRequestDisplay } from "../ports/pending-requests.ts";
import type { SlackPromptCard } from "../ports/slack-outbox-store.ts";
import {
  SLACK_PROMPT_MESSAGES,
  type SlackPrompt,
  type SlackPromptResult,
  slackCardText,
  slackDoneCard,
  slackPromptMessage,
  slackQuestionAnswers,
  slackRejectOnlyCard,
  slackSettledCard,
} from "./slack-prompts.ts";

const SESSION = "019a0000-0000-7000-8000-0000000000a5";
const HOSTILE = "<!channel> <https://evil.example|click> *bold*";
// The three shapes a model may write that Slack would turn live in mrkdwn.
const LIVE = ["<@U123>", "<!channel>", "<https://x|y>"];
const LINK = "https://console.example/sessions/x";

const mrkdwnTexts = (blocks: unknown[]) =>
  JSON.stringify(blocks)
    .match(/"type":"mrkdwn","text":"(?:[^"\\]|\\.)*"/g)
    ?.join("\n") ?? "";

/** Every block, container children included, as Slack counts toward 50. */
function countBlocks(blocks: unknown[]): number {
  return blocks.reduce<number>((total, block) => {
    const children = (block as { child_blocks?: unknown[] }).child_blocks;
    return total + 1 + (children ? countBlocks(children) : 0);
  }, 0);
}

const typesOf = (blocks: unknown[]) =>
  blocks.map((block) => (block as { type: string }).type);

const question = (options: number, extra: Partial<PendingQuestion> = {}) => ({
  question_id: "q-1",
  prompt: HOSTILE,
  options: Array.from({ length: options }, (_, i) => ({
    option_id: `o${i}`,
    label: `${HOSTILE} ${i}`,
  })),
  multi_select: false,
  allow_free_text: false,
  ...extra,
});

const permission = (
  input: unknown,
  extra: Partial<Extract<SlackPrompt, { kind: "permission" }>> = {},
): SlackPrompt => ({
  kind: "permission",
  sessionId: SESSION,
  requestId: "toolu_1",
  tool: "Bash",
  input,
  context: {},
  expiresAt: "2026-11-03T00:00:00Z",
  ...extra,
});

const push = (extra: Partial<Extract<SlackPrompt, { kind: "push" }>> = {}) =>
  ({
    kind: "push",
    sessionId: SESSION,
    requestId: "push-1",
    repositoryId: "repo-1",
    repositoryName: "JeongJaeSoon/werft-sandbox",
    targetBranch: "agent/x",
    gitCommit: "abcdef1234567890".padEnd(40, "0"),
    ...extra,
  }) satisfies SlackPrompt;

describe("Slack prompt cards", () => {
  test("model-written text never reaches a mrkdwn field", () => {
    for (const prompt of [
      permission({ command: HOSTILE }, { tool: HOSTILE }),
      {
        kind: "question" as const,
        sessionId: SESSION,
        requestId: "q_1",
        questions: [question(3)],
        expiresAt: "2026-11-03T00:00:00Z",
      },
      push({ targetBranch: HOSTILE, repositoryName: HOSTILE }),
    ]) {
      const { blocks } = slackPromptMessage(prompt, {
        locale: "en",
        requesterSlackUserId: "U0ASKER",
        linkUrl: LINK,
      });
      const mrkdwn = mrkdwnTexts(blocks);
      expect(mrkdwn).toContain("<@U0ASKER>");
      expect(mrkdwn).not.toContain("evil.example");
      expect(mrkdwn).not.toContain("<!channel>");
      expect(JSON.stringify(blocks)).toContain("evil.example");
    }
  });

  test("a malformed requester id or link is left out, not interpolated", () => {
    const { blocks, text } = slackPromptMessage(permission(null), {
      locale: "en",
      requesterSlackUserId: "U0X> <!here",
      linkUrl: "javascript:alert(1)",
    });
    expect(text).not.toContain("<!here");
    expect(text).not.toContain("javascript:");
    expect(JSON.stringify(blocks)).not.toContain("javascript:");
    expect(JSON.stringify(blocks)).not.toContain("<!here");
  });

  test("a tool card: title, the request in plain words, the raw input folded, buttons, meta", () => {
    const { blocks, text } = slackPromptMessage(
      permission({ command: "npm test", description: "Run the tests" }),
      { locale: "ko", requesterSlackUserId: "U0ASKER", linkUrl: LINK },
    );
    expect(typesOf(blocks)).toEqual([
      "section",
      "section",
      "container",
      "actions",
      "context",
    ]);
    expect(blocks[1]).toEqual({
      type: "section",
      text: {
        type: "plain_text",
        text: "명령 실행: Run the tests",
        emoji: false,
      },
    });
    const folded = blocks[2] as {
      is_collapsible: boolean;
      default_collapsed: boolean;
      title: { type: string; text: string };
      child_blocks: { type: string; elements: { type: string }[] }[];
    };
    expect(folded.is_collapsible).toBe(true);
    expect(folded.default_collapsed).toBe(true);
    expect(folded.title).toMatchObject({
      type: "plain_text",
      text: "입력 원본 (Bash)",
    });
    expect(folded.child_blocks[0]?.elements[0]?.type).toBe(
      "rich_text_preformatted",
    );
    expect(JSON.stringify(folded)).toContain("npm test");
    expect(text).toBe(
      `<@U0ASKER> 도구 사용 허용이 필요해요\n명령 실행: Run the tests\n<${LINK}|웹에서 열기>`,
    );
  });

  test("a Write card shows the path, the content's first lines and the raw input with real line breaks", () => {
    // The owner's report: the card showed the input as JSON, `\n` and all.
    const content =
      "# werft-sandbox\n\nagent-platform의 GitHub 연동을 점검하기 위한 테스트 저장소입니다.\n\n## 구성\n";
    const { blocks } = slackPromptMessage(
      permission({ content, file_path: "README.md" }, { tool: "Write" }),
      { locale: "ko", requesterSlackUserId: null, linkUrl: LINK },
    );
    const preText = (block: unknown) =>
      (
        block as {
          elements: { elements: { text: string }[] }[];
        }
      ).elements[0]?.elements[0]?.text;
    expect(typesOf(blocks)).toEqual([
      "section",
      "section",
      "rich_text",
      "container",
      "actions",
      "context",
    ]);
    expect(JSON.stringify(blocks[1])).toContain("파일 쓰기: README.md");
    expect(preText(blocks[2])).toBe(
      "# werft-sandbox\n\nagent-platform의 GitHub 연동을 점검하기 위한 테스트 저장소입니다.\n…",
    );
    const raw = preText(
      (blocks[3] as { child_blocks: unknown[] }).child_blocks[0],
    );
    expect(raw).toBe(`content:\n${content}\nfile_path: README.md`);
    expect(raw).not.toContain("\\n");
    expect(raw).not.toContain('"content"');
  });

  test("a push card shows the catalog name, a 7-character commit and a shortened branch", () => {
    const branch = `agent/${SESSION}-a-rather-long-suffix`;
    const { blocks, text } = slackPromptMessage(
      push({ targetBranch: branch }),
      { locale: "en", requesterSlackUserId: null, linkUrl: LINK },
    );
    expect(typesOf(blocks)).toEqual([
      "section",
      "section",
      "container",
      "actions",
      "context",
    ]);
    const fields = (blocks[1] as { fields: { text: string }[] }).fields.map(
      (field) => field.text,
    );
    expect(fields[0]).toBe("Repository");
    expect(fields[1]).toBe("JeongJaeSoon/werft-sandbox");
    expect(fields[3]).toHaveLength(40);
    expect(fields[3]?.startsWith("agent/")).toBe(true);
    expect(fields[3]?.endsWith("rather-long-suffix")).toBe(true);
    expect(fields[5]).toBe("abcdef1");
    // The whole branch and commit are folded under "Details".
    expect(JSON.stringify(blocks[2])).toContain(branch);
    expect(JSON.stringify(blocks[2])).toContain(push().gitCommit);
    // No expiry: a push request has none.
    expect(mrkdwnTexts(blocks)).not.toContain("Expires");
    expect(text).toContain(`JeongJaeSoon/werft-sandbox · ${branch}`);
  });

  test("a push card without a catalog name shows the repository id", () => {
    const { blocks } = slackPromptMessage(push({ repositoryName: null }), {
      locale: "en",
      requesterSlackUserId: null,
    });
    expect(JSON.stringify(blocks[1])).toContain('"repo-1"');
  });

  test("a question too large for the modal is answered on the web", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...question(2),
      question_id: `q-${i}`,
    }));
    for (const questions of [many, [question(101)]]) {
      const { blocks } = slackPromptMessage(
        {
          kind: "question",
          sessionId: SESSION,
          requestId: "q_1",
          questions,
          expiresAt: "2026-11-03T00:00:00Z",
        },
        { locale: "ko", requesterSlackUserId: null, linkUrl: LINK },
      );
      expect(JSON.stringify(blocks)).toContain("이 요청은 웹에서 답해 주세요");
      const actions = blocks.find(
        (b) => (b as { type: string }).type === "actions",
      ) as { elements: { url?: string; value?: string }[] };
      expect(actions.elements).toHaveLength(1);
      expect(actions.elements[0]?.url).toBe(LINK);
      expect(actions.elements[0]?.value).toBeUndefined();
    }
    const { blocks } = slackPromptMessage(
      {
        kind: "question",
        sessionId: SESSION,
        requestId: "q_1",
        questions: many,
        expiresAt: "2026-11-03T00:00:00Z",
      },
      { locale: "ko", requesterSlackUserId: null },
    );
    expect(typesOf(blocks)).not.toContain("actions");
  });

  test("no card goes over Slack's 50 blocks, container children counted", () => {
    const largest = [
      slackPromptMessage(
        {
          kind: "question",
          sessionId: SESSION,
          requestId: "q_1",
          questions: Array.from({ length: 10 }, (_, i) => ({
            ...question(100, { allow_free_text: true }),
            question_id: `q-${i}`,
          })),
          expiresAt: "2026-11-03T00:00:00Z",
        },
        { locale: "en", requesterSlackUserId: "U0ASKER", linkUrl: LINK },
      ),
      slackPromptMessage(permission({ command: "x".repeat(10_000) }), {
        locale: "en",
        requesterSlackUserId: "U0ASKER",
        linkUrl: LINK,
      }),
      slackPromptMessage(push(), {
        locale: "en",
        requesterSlackUserId: "U0ASKER",
        linkUrl: LINK,
      }),
    ];
    for (const { blocks } of largest) {
      expect(countBlocks(blocks)).toBeLessThanOrEqual(50);
    }
    expect(countBlocks(largest[0]?.blocks ?? [])).toBe(13);
  });

  test("a simple question gets option buttons; a larger one opens a form", () => {
    const actionIds = (questions: PendingQuestion[]) => {
      const { blocks } = slackPromptMessage(
        {
          kind: "question",
          sessionId: SESSION,
          requestId: "q_1",
          questions,
          expiresAt: "2026-11-03T00:00:00Z",
        },
        { locale: "en", requesterSlackUserId: null },
      );
      const actions = blocks.find(
        (b) => (b as { type: string }).type === "actions",
      ) as { elements: { action_id: string; value: string }[] };
      return actions.elements.map((e) => [e.action_id, JSON.parse(e.value).o]);
    };
    expect(actionIds([question(2, { allow_free_text: true })])).toEqual([
      ["question.option:0", "0"],
      ["question.option:1", "1"],
      ["question.open", undefined],
    ]);
    expect(actionIds([question(6)])).toEqual([["question.open", undefined]]);
    expect(actionIds([question(2, { multi_select: true })])).toEqual([
      ["question.open", undefined],
    ]);
  });

  test("every button in a block has its own action_id, as Slack requires", () => {
    const { blocks } = slackPromptMessage(
      {
        kind: "question",
        sessionId: SESSION,
        requestId: "q_1",
        questions: [question(5, { allow_free_text: true })],
        expiresAt: "2026-11-03T00:00:00Z",
      },
      { locale: "en", requesterSlackUserId: null },
    );
    for (const block of blocks as {
      type: string;
      elements?: { action_id: string }[];
    }[]) {
      if (block.type !== "actions") continue;
      const ids = (block.elements ?? []).map((e) => e.action_id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("a submitted form maps option indexes back to the stored options only", () => {
    const questions = [question(2, { multi_select: true })];
    expect(
      slackQuestionAnswers(
        questions,
        {
          q0: {
            v: { selected_options: [{ value: "1" }, { value: "0" }] },
          },
        },
        "en",
      ),
    ).toEqual({
      ok: true,
      answers: [{ question_id: "q-1", selected_option_ids: ["o1", "o0"] }],
    });
    expect(
      slackQuestionAnswers(
        questions,
        { q0: { v: { selected_options: [{ value: "o1" }] } } },
        "en",
      ).ok,
    ).toBe(false);
  });

  test("every language has every card word", () => {
    const results: SlackPromptResult[] = [
      "allowed",
      "denied",
      "answered",
      "approved",
      "rejected",
      "expired",
      "closed",
    ];
    for (const locale of USER_LOCALE_VALUES) {
      const copy = SLACK_PROMPT_MESSAGES[locale];
      for (const result of results) {
        expect(copy.settled[result]).not.toBe("");
        expect(copy.already[result]).not.toBe("");
      }
      for (const word of [
        copy.rawInput,
        copy.details,
        copy.typedAnswer,
        copy.pushStale,
        copy.done,
        copy.answerOnWeb,
        copy.openConsole,
      ]) {
        expect(word).not.toBe("");
      }
      expect(copy.rawInput).toContain("{tool}");
      expect(copy.chosen.slack).toContain("{answer}");
      expect(copy.chosen.web).toContain("{answer}");
    }
  });
});

describe("slackCardText", () => {
  test("a model's mention, broadcast or link in a tool input, option label or PR title stays inert", () => {
    for (const hostile of LIVE) {
      const cards = [
        slackPromptMessage(permission({ command: hostile }), {
          locale: "en",
          requesterSlackUserId: null,
          linkUrl: LINK,
        }),
        slackPromptMessage(
          permission(
            { title: hostile, push_request_id: SESSION },
            { tool: "mcp__github__open_pull_request" },
          ),
          { locale: "en", requesterSlackUserId: null, linkUrl: LINK },
        ),
        slackPromptMessage(
          {
            kind: "question",
            sessionId: SESSION,
            requestId: "q_1",
            questions: [
              {
                question_id: "q-1",
                prompt: hostile,
                options: [{ option_id: "o0", label: hostile }],
                multi_select: false,
                allow_free_text: false,
              },
            ],
            expiresAt: "2026-11-03T00:00:00Z",
          },
          { locale: "en", requesterSlackUserId: null, linkUrl: LINK },
        ),
      ];
      for (const { text, blocks } of cards) {
        expect(text).not.toContain(hostile);
        expect(mrkdwnTexts(blocks)).not.toContain(hostile);
      }
    }
  });

  test("escapes every piece but a checked mention and the platform's link", () => {
    expect(
      slackCardText({
        locale: "en",
        title: "A & B",
        mentionSlackUserId: "U0ASKER",
        lines: ["<@U123> <!channel> <https://x|y>"],
        linkUrl: LINK,
      }),
    ).toBe(
      `<@U0ASKER> A &amp; B\n&lt;@U123&gt; &lt;!channel&gt; &lt;https://x|y&gt;\n<${LINK}|Open on the web>`,
    );
    expect(
      slackCardText({
        locale: "ja",
        title: "t",
        mentionSlackUserId: "<!here>",
        linkUrl: null,
      }),
    ).toBe("t\nWebコンソールで確認してください");
  });
});

const card = (
  display: SlackPromptCard["display"],
  extra: Partial<SlackPromptCard> = {},
): SlackPromptCard => ({
  locale: "ko",
  linkUrl: LINK,
  decidedVia: "slack",
  deciderSlackUserId: "U0DECIDER",
  display,
  ...extra,
});

const base = {
  decision: null,
  decidedByUserId: "019a0000-0000-7000-8000-00000000d0e1",
  closedReason: null,
  createdAt: "2026-11-03T00:00:00Z",
  expiresAt: "2026-11-03T01:00:00Z",
} as const;

const askedTool = (
  extra: Partial<PendingRequestDisplay> = {},
): PendingRequestDisplay =>
  ({
    ...base,
    kind: "permission",
    tool: "Bash",
    input: { command: "npm test" },
    context: {},
    state: "answered",
    decision: "allow",
    ...extra,
  }) as PendingRequestDisplay;

const askedQuestion = (
  answers: { selected_option_ids: string[]; typed: boolean },
  questions = [question(2, { prompt: "Which branch?", allow_free_text: true })],
): PendingRequestDisplay => ({
  ...base,
  kind: "question",
  questions,
  answers: [{ question_id: "q-1", ...answers }],
  state: "answered",
});

const settledLine = (settled: { blocks: unknown[] } | null) => {
  expect(settled?.blocks).toHaveLength(1);
  const [block] = settled?.blocks as {
    type: string;
    elements: { type: string; text: string }[];
  }[];
  expect(block?.type).toBe("context");
  return block?.elements.map((element) => element.text) ?? [];
};

describe("slackSettledCard", () => {
  test("is null while the request can still be settled", () => {
    expect(slackSettledCard(card(askedTool({ state: "open" })))).toBeNull();
    expect(
      slackSettledCard(
        card({
          kind: "push",
          repositoryId: "repo-1",
          repositoryName: null,
          targetBranch: "agent/x",
          gitCommit: "a".repeat(40),
          state: "requested",
          decidedByUserId: null,
          createdAt: "2026-11-03T00:00:00Z",
        }),
      ),
    ).toBeNull();
  });

  test("an allowed tool: one context line, how it ended, who, the request, the link", () => {
    const settled = slackSettledCard(card(askedTool()));
    expect(settledLine(settled)).toEqual([
      ":white_check_mark: *허용됨* · <@U0DECIDER>",
      "명령 실행: npm test",
      `<${LINK}|웹에서 열기>`,
    ]);
    expect(settled?.text).toBe(
      `*허용됨* · <@U0DECIDER>\n명령 실행: npm test\n<${LINK}|웹에서 열기>`,
    );
  });

  test("the path comes from the stored decision; the decider follows as a bare mention", () => {
    const line = (
      decidedVia: "slack" | "web" | null,
      deciderSlackUserId: string | null,
      locale: UserLocale = "ko",
    ) =>
      settledLine(
        slackSettledCard(
          card(askedTool(), { decidedVia, deciderSlackUserId, locale }),
        ),
      )[0];
    expect(line("web", "U0DECIDER")).toBe(
      ":white_check_mark: *웹에서 허용됨* · <@U0DECIDER>",
    );
    expect(line("slack", "U0DECIDER")).toBe(
      ":white_check_mark: *허용됨* · <@U0DECIDER>",
    );
    // No linked Slack account: the result and path alone.
    expect(line("web", null)).toBe(":white_check_mark: *웹에서 허용됨*");
    expect(line(null, null)).toBe(":white_check_mark: *허용됨*");
    // A malformed id is no mention, and leaves no dangling separator.
    expect(line(null, "<!channel>")).toBe(":white_check_mark: *허용됨*");
    expect(line("web", "U0DECIDER", "ja")).toBe(
      ":white_check_mark: *Webで許可済み* · <@U0DECIDER>",
    );
    expect(line("web", "U0DECIDER", "en")).toBe(
      ":white_check_mark: *Allowed on the web* · <@U0DECIDER>",
    );
    // No honorific glued to a mention Slack draws as a name.
    expect(line("slack", "U0DECIDER")).not.toContain("님");
    expect(
      slackSettledCard(
        card(askedTool(), {
          decidedVia: "web",
          deciderSlackUserId: "U0DECIDER",
          linkUrl: null,
        }),
      )?.text,
    ).toBe(
      "*웹에서 허용됨* · <@U0DECIDER>\n명령 실행: npm test\n웹 콘솔에서 확인해 주세요",
    );
    // The text reads as the block does, in every language.
    for (const [locale, sentence] of [
      ["ko", "*웹에서 push 거절됨* · <@U0DECIDER>"],
      ["ja", "*Webでpush却下済み* · <@U0DECIDER>"],
      ["en", "*Push rejected on the web* · <@U0DECIDER>"],
    ] as const) {
      const settled = slackSettledCard(
        card(
          {
            kind: "push",
            repositoryId: "repo-1",
            repositoryName: null,
            targetBranch: "agent/x",
            gitCommit: "abcdef1".padEnd(40, "0"),
            state: "rejected",
            decidedByUserId: base.decidedByUserId,
            createdAt: "2026-11-03T00:00:00Z",
          },
          { locale, linkUrl: null, decidedVia: "web" },
        ),
      );
      expect(settled?.text.split("\n")[0]).toBe(sentence);
      expect(settledLine(settled)[0]).toBe(`:no_entry_sign: ${sentence}`);
    }
  });

  test("every language has a web line for every decided result", () => {
    for (const locale of USER_LOCALE_VALUES as readonly UserLocale[]) {
      const copy = SLACK_PROMPT_MESSAGES[locale];
      for (const result of [
        "allowed",
        "denied",
        "answered",
        "approved",
        "rejected",
      ] as const) {
        expect(copy.settledOnWeb[result]).not.toBe("");
        expect(copy.settledOnWeb[result]).not.toBe(copy.settled[result]);
      }
    }
  });

  test("an expired or closed request names nobody", () => {
    for (const [closedReason, line] of [
      ["expired", ":hourglass: *만료됨*"],
      ["stale", ":white_circle: *더 이상 답할 수 없어요*"],
      ["session_closed", ":white_circle: *더 이상 답할 수 없어요*"],
    ] as const) {
      const lines = settledLine(
        slackSettledCard(
          card(
            askedTool({
              state: "closed",
              decision: null,
              decidedByUserId: null,
              closedReason,
            }),
          ),
        ),
      );
      expect(lines[0]).toBe(line);
    }
  });

  test("an answered question keeps its full text with the answer under it", () => {
    const long = `${"Which branch should the README change go on, ".repeat(3)}?`;
    const settled = slackSettledCard(
      card(
        askedQuestion({ selected_option_ids: ["o1"], typed: false }, [
          question(2, { prompt: long }),
        ]),
      ),
    );
    expect(settled?.blocks).toEqual([
      {
        type: "section",
        text: { type: "plain_text", text: long, emoji: false },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: ":speech_balloon:" },
          {
            type: "plain_text",
            text: `${HOSTILE} 1 선택됨`,
            emoji: false,
          },
          { type: "mrkdwn", text: "· <@U0DECIDER>" },
          { type: "mrkdwn", text: `<${LINK}|웹에서 열기>` },
        ],
      },
    ]);
    // The question is no longer cut to its head.
    expect(JSON.stringify(settled?.blocks)).toContain(long);
  });

  test("a question answered on the web: `웹에서 <label> 선택됨 · who`, a typed answer only as 직접 입력", () => {
    for (const [locale, answer] of [
      ["ko", `웹에서 ${HOSTILE} 1, 직접 입력 선택됨`],
      ["ja", `Webで${HOSTILE} 1, 直接入力を選択`],
      ["en", `Chose ${HOSTILE} 1, a typed answer on the web`],
    ] as const) {
      const settled = slackSettledCard(
        card(askedQuestion({ selected_option_ids: ["o1"], typed: true }), {
          locale,
          decidedVia: "web",
        }),
      );
      const [section, context] = settled?.blocks as {
        type: string;
        text?: { text: string };
        elements?: { type: string; text: string }[];
      }[];
      expect(section?.text?.text).toBe("Which branch?");
      expect(context?.elements?.map((element) => element.text)).toEqual([
        ":speech_balloon:",
        answer,
        "· <@U0DECIDER>",
        `<${LINK}|${SLACK_PROMPT_MESSAGES[locale].link}>`,
      ]);
      // The label is model text: plain text in the block, escaped in `text`.
      expect(context?.elements?.[1]?.type).toBe("plain_text");
      expect(settled?.text).not.toContain("<!channel>");
    }
  });

  test("several answered questions each keep their text and answer, then one footer", () => {
    const settled = slackSettledCard(
      card(
        {
          ...askedQuestion({ selected_option_ids: ["o0"], typed: false }, [
            question(2, { prompt: "First?" }),
            { ...question(2, { prompt: "Second?" }), question_id: "q-2" },
          ]),
          answers: [
            { question_id: "q-1", selected_option_ids: ["o0"], typed: false },
            { question_id: "q-2", selected_option_ids: [], typed: true },
          ],
        } as PendingRequestDisplay,
        { decidedVia: "web" },
      ),
    );
    const texts = (
      settled?.blocks as {
        text?: { text: string };
        elements?: { text: string }[];
      }[]
    ).map(
      (block) =>
        block.text?.text ?? block.elements?.map((e) => e.text).join(" | "),
    );
    expect(texts).toEqual([
      "First?",
      `${HOSTILE} 0 선택됨`,
      "Second?",
      "직접 입력 선택됨",
      `:speech_balloon: *웹에서 답함* · <@U0DECIDER> | <${LINK}|웹에서 열기>`,
    ]);
  });

  test("an expired question keeps its text over the result line", () => {
    const settled = slackSettledCard(
      card({
        ...askedQuestion({ selected_option_ids: [], typed: false }),
        answers: [],
        state: "closed",
        decidedByUserId: null,
        closedReason: "expired",
      } as PendingRequestDisplay),
    );
    const texts = (
      settled?.blocks as {
        text?: { text: string };
        elements?: { text: string }[];
      }[]
    ).map(
      (block) =>
        block.text?.text ?? block.elements?.map((e) => e.text).join(" | "),
    );
    expect(texts).toEqual([
      "Which branch?",
      `:hourglass: *만료됨* | <${LINK}|웹에서 열기>`,
    ]);
  });

  test("a decided push names the repository, the short commit and the branch", () => {
    const decided = (state: "approved" | "pushed" | "rejected") =>
      settledLine(
        slackSettledCard(
          card(
            {
              kind: "push",
              repositoryId: "repo-1",
              repositoryName: "JeongJaeSoon/werft-sandbox",
              targetBranch: "agent/x",
              gitCommit: "abcdef1".padEnd(40, "0"),
              state,
              decidedByUserId: base.decidedByUserId,
              createdAt: "2026-11-03T00:00:00Z",
            },
            { locale: "en" },
          ),
        ),
      );
    expect(decided("pushed").slice(0, 2)).toEqual([
      ":white_check_mark: *Push approved* · <@U0DECIDER>",
      "JeongJaeSoon/werft-sandbox ← abcdef1 · agent/x",
    ]);
    expect(decided("rejected")[0]).toBe(
      ":no_entry_sign: *Push rejected* · <@U0DECIDER>",
    );
  });

  test("model text in a settled line is plain text, and the card's language is its own", () => {
    for (const locale of USER_LOCALE_VALUES as readonly UserLocale[]) {
      const settled = slackSettledCard(
        card(
          askedTool({
            tool: "mcp__github__open_pull_request",
            input: { title: "<!channel>", push_request_id: SESSION },
          }),
          { locale },
        ),
      );
      expect(mrkdwnTexts(settled?.blocks ?? [])).not.toContain("<!channel>");
      expect(settled?.text).not.toContain("<!channel>");
      expect(settledLine(settled)[0]).toContain(
        SLACK_PROMPT_MESSAGES[locale].settled.allowed,
      );
    }
  });
});

describe("slackRejectOnlyCard", () => {
  test("a push the checkpoint moved past keeps only Reject, with the reason", () => {
    const pushCard = card({
      kind: "push",
      repositoryId: "repo-1",
      repositoryName: "JeongJaeSoon/werft-sandbox",
      targetBranch: "agent/x",
      gitCommit: "abcdef1".padEnd(40, "0"),
      state: "requested",
      decidedByUserId: null,
      createdAt: "2026-11-03T00:00:00Z",
    }) as Parameters<typeof slackRejectOnlyCard>[0];
    const stale = slackRejectOnlyCard(pushCard, {
      sessionId: SESSION,
      requestId: "push-1",
    });
    const [context, actions] = stale.blocks as {
      type: string;
      elements: {
        type: string;
        text: unknown;
        action_id?: string;
        style?: string;
      }[];
    }[];
    expect(context?.elements.map((element) => element.text)).toEqual([
      ":warning: *새 커밋이 생겨 이 push는 승인할 수 없어요*",
      "JeongJaeSoon/werft-sandbox ← abcdef1",
    ]);
    expect(actions?.type).toBe("actions");
    expect(actions?.elements.map((element) => element.style)).toEqual([
      "danger",
    ]);
    expect(stale.text.split("\n")[0]).toBe(
      "새 커밋이 생겨 이 push는 승인할 수 없어요",
    );
  });
});

describe("slackDoneCard", () => {
  test("a turn's notice from before the cards ends as one handled line", () => {
    expect(slackDoneCard("en", LINK)).toEqual({
      text: `Handled\n<${LINK}|Open on the web>`,
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: ":white_circle: *Handled*" },
            { type: "mrkdwn", text: `<${LINK}|Open on the web>` },
          ],
        },
      ],
    });
  });
});

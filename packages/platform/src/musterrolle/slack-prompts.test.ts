import { describe, expect, test } from "bun:test";
import type { PendingQuestion } from "@werft-ai/contracts";
import {
  slackPromptMessage,
  slackQuestionAnswers,
  slackSettledBlocks,
} from "./slack-prompts.ts";

const SESSION = "019a0000-0000-7000-8000-0000000000a5";
const HOSTILE = "<!channel> <https://evil.example|click> *bold*";

const mrkdwnTexts = (blocks: unknown[]) =>
  JSON.stringify(blocks)
    .match(/"type":"mrkdwn","text":"(?:[^"\\]|\\.)*"/g)
    ?.join("\n") ?? "";

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

describe("Slack prompt cards", () => {
  test("model-written text never reaches a mrkdwn field", () => {
    for (const prompt of [
      {
        kind: "permission" as const,
        sessionId: SESSION,
        requestId: "toolu_1",
        tool: HOSTILE,
        input: { command: HOSTILE },
        expiresAt: "2026-11-03T00:00:00Z",
      },
      {
        kind: "question" as const,
        sessionId: SESSION,
        requestId: "q_1",
        questions: [question(3)],
        expiresAt: "2026-11-03T00:00:00Z",
      },
      {
        kind: "push" as const,
        sessionId: SESSION,
        requestId: "push-1",
        repositoryId: "repo-1",
        targetBranch: HOSTILE,
        gitCommit: "a".repeat(40),
      },
    ]) {
      const { blocks } = slackPromptMessage(prompt, {
        locale: "en",
        requesterSlackUserId: "U0ASKER",
        linkUrl: "https://console.example/sessions/x",
      });
      const mrkdwn = mrkdwnTexts(blocks);
      expect(mrkdwn).toContain("<@U0ASKER>");
      expect(mrkdwn).not.toContain("evil.example");
      expect(mrkdwn).not.toContain("<!channel>");
      expect(JSON.stringify(blocks)).toContain("evil.example");
    }
  });

  test("a malformed requester id or link is left out, not interpolated", () => {
    const { blocks, text } = slackPromptMessage(
      {
        kind: "permission",
        sessionId: SESSION,
        requestId: "toolu_1",
        tool: "Bash",
        input: null,
        expiresAt: "2026-11-03T00:00:00Z",
      },
      {
        locale: "en",
        requesterSlackUserId: "U0X> <!here",
        linkUrl: "javascript:alert(1)",
      },
    );
    expect(text).not.toContain("<!here");
    expect(JSON.stringify(blocks)).not.toContain("javascript:");
    expect(JSON.stringify(blocks)).not.toContain("<!here");
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
      ["question.option", "0"],
      ["question.option", "1"],
      ["question.open", undefined],
    ]);
    expect(actionIds([question(6)])).toEqual([["question.open", undefined]]);
    expect(actionIds([question(2, { multi_select: true })])).toEqual([
      ["question.open", undefined],
    ]);
  });

  test("a settled card drops its buttons and expiry and names who settled it", () => {
    const { blocks } = slackPromptMessage(
      {
        kind: "push",
        sessionId: SESSION,
        requestId: "push-1",
        repositoryId: "repo-1",
        targetBranch: "agent/x",
        gitCommit: "a".repeat(40),
      },
      {
        locale: "ko",
        requesterSlackUserId: null,
        linkUrl: "https://console.example/x",
      },
    );
    const settled = slackSettledBlocks(blocks, "approved", {
      locale: "ko",
      slackUserId: "U0PRESSER",
    });
    const json = JSON.stringify(settled.blocks);
    expect(json).not.toContain('"actions"');
    expect(json).not.toContain("prompt.meta");
    expect(settled.text).toContain("<@U0PRESSER>");
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
});

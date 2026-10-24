import { describe, expect, test } from "bun:test";
import {
  finalReplyText,
  SLACK_OUTBOX_MESSAGES,
  SLACK_TEXT_MAX,
  slackOutboxText,
  slackTurnDedupeKey,
} from "./slack-outbox.ts";

const said = (...content: Record<string, unknown>[]) => ({
  type: "assistant",
  payload: { message: { content } },
});
const text = (value: string) => ({ type: "text", text: value });
const tool = { type: "tool_use", name: "Read", input: {} };

describe("finalReplyText", () => {
  test("keeps what came after the last tool call, across events", () => {
    expect(
      finalReplyText([
        said(text("Looking."), tool),
        said(text("Found it.")),
        said({ type: "thinking", thinking: "hm" }, text("Here it is.")),
      ]),
    ).toBe("Found it.\n\nHere it is.");
  });

  test("is empty when the turn ended on a tool call or said nothing", () => {
    expect(finalReplyText([said(text("Looking."), tool)])).toBe("");
    expect(finalReplyText([{ type: "assistant", payload: null }])).toBe("");
  });
});

describe("slackOutboxText", () => {
  const link = `\n\n<https://console.example/sessions/s1|${SLACK_OUTBOX_MESSAGES.link}>`;

  test("escapes every control and appends the link unescaped", () => {
    expect(
      slackOutboxText({
        text: "<!channel> <@U1> <#C1> <!subteam^S1>",
        link_url: "https://console.example/sessions/s1",
      }),
    ).toBe(
      `&lt;!channel&gt; &lt;@U1&gt; &lt;#C1&gt; &lt;!subteam^S1&gt;${link}`,
    );
  });

  test("drops a link Slack would read as more than a link", () => {
    expect(
      slackOutboxText({ text: "hi", link_url: "https://x.example/a|b>" }),
    ).toBe("hi");
    expect(slackOutboxText({ text: "hi", link_url: "" })).toBe("hi");
    expect(slackOutboxText({ text: "hi", link_url: "javascript:x" })).toBe(
      "hi",
    );
  });

  test("cuts to Slack's limit, never inside an escape or a surrogate pair", () => {
    const room = SLACK_TEXT_MAX - link.length;
    const url = "https://console.example/sessions/s1";
    const entity = slackOutboxText({
      text: `${"a".repeat(room - 3)}&&&&`,
      link_url: url,
    });
    expect(entity.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(entity).toEndWith(`aa…${link}`);

    const emoji = slackOutboxText({
      text: `${"a".repeat(room - 2)}😀😀`,
      link_url: url,
    });
    expect(emoji.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(emoji).toEndWith(`a…${link}`);
    expect(emoji.isWellFormed()).toBe(true);
  });

  test("leaves text that fits alone", () => {
    const fits = "b".repeat(SLACK_TEXT_MAX);
    expect(slackOutboxText({ text: fits })).toBe(fits);
  });
});

test("one dedupe key per turn and kind", () => {
  expect(slackTurnDedupeKey("completed", "l1", 2)).toBe("reply:l1:2");
  expect(slackTurnDedupeKey("failed", "l1", 2)).toBe("failure:l1:2");
  expect(slackTurnDedupeKey("needs_input", "l1", 2)).toBe("input:l1:2");
});

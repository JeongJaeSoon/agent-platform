import { describe, expect, test } from "bun:test";
import {
  finalReplyText,
  SLACK_OUTBOX_MESSAGES,
  SLACK_TEXT_MAX,
  slackOutboxText,
  slackTurnDedupeKey,
} from "./slack-outbox.ts";

// One event per block, as the runtime's codec gives them.
const said = (fields: Record<string, unknown>) => ({
  type: "assistant",
  payload: { type: "assistant", ...fields },
});
const text = (value: string) => said({ text: value });
const tool = said({
  tool_call: { id: "tu_1", name: "Read", input: {} },
});

describe("finalReplyText", () => {
  test("keeps what came after the last tool call, across events", () => {
    expect(
      finalReplyText([
        text("Looking."),
        tool,
        text("Found it."),
        said({ thinking: "hm" }),
        text("Here it is."),
        // The engine's own message is not read.
        said({ message: { content: [{ type: "text", text: "not shown" }] } }),
      ]),
    ).toBe("Found it.\n\nHere it is.");
  });

  test("is empty when the turn ended on a tool call or said nothing", () => {
    expect(finalReplyText([text("Looking."), tool])).toBe("");
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

  test("writes a masked link out so its label cannot hide the address", () => {
    expect(
      slackOutboxText({ text: "<https://evil.example/login|웹에서 승인>" }),
    ).toBe("웹에서 승인 (https://evil.example/login)");
  });

  test("lets through only the mentions the body names", () => {
    expect(
      slackOutboxText({
        text: "<@U1> <@U2> <!here>",
        mention_user_ids: ["U1"],
      }),
    ).toBe("<@U1> &lt;@U2&gt; &lt;!here&gt;");
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
    // Throws on a lone surrogate.
    expect(() => encodeURIComponent(emoji)).not.toThrow();
  });

  test("a cut that leaves a code fence open escapes what the fence held", () => {
    const cut = slackOutboxText({
      text: `\`\`\`\n<!channel> <@U2> <@U1>\n${"a".repeat(SLACK_TEXT_MAX)}\n\`\`\``,
      mention_user_ids: ["U1"],
    });
    expect(cut.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(cut).toStartWith("```\n&lt;!channel&gt; &lt;@U2&gt; &lt;@U1&gt;\n");
    expect(cut).toEndWith("a…");
    // A fence still closed after the cut shows its control as written.
    expect(
      slackOutboxText({ text: `\`<!here>\` ${"b".repeat(SLACK_TEXT_MAX)}` }),
    ).toStartWith("`&lt;!here&gt;` b");
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

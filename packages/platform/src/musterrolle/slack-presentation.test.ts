import { describe, expect, test } from "bun:test";

import { escapeSlackControls } from "./slack-presentation.ts";

describe("escapeSlackControls without a policy", () => {
  test.each([
    ["<!here>", "&lt;!here&gt;"],
    ["<!channel>", "&lt;!channel&gt;"],
    ["<!everyone>", "&lt;!everyone&gt;"],
    ["<!subteam^S1>", "&lt;!subteam^S1&gt;"],
    ["<!subteam^S1|@oncall>", "&lt;!subteam^S1|@oncall&gt;"],
    ["<#C1|name>", "&lt;#C1|name&gt;"],
    ["<#C1>", "&lt;#C1&gt;"],
    ["<@U1>", "&lt;@U1&gt;"],
    ["<@W1>", "&lt;@W1&gt;"],
    ["<javascript:alert(1)>", "&lt;javascript:alert(1)&gt;"],
  ])("escapes %s", (input, expected) => {
    expect(escapeSlackControls(input)).toBe(expected);
  });

  test("a nested control inside a link label cannot ride along", () => {
    // Kollegium presentation.test.ts: unsafe destinations, nested case.
    const escaped = escapeSlackControls(
      "<https://example.com|notify <!channel>>",
    );
    expect(escaped).not.toContain("<!channel>");
    expect(escaped).toContain("&lt;!channel&gt;");
  });

  test("an untrusted mention is escaped while a safe link stays a link", () => {
    // Kollegium web-api.test.ts: ordinary safe mrkdwn without implicit mentions.
    expect(
      escapeSlackControls("*수요일* <@U123> <https://example.com|문서>"),
    ).toBe("*수요일* &lt;@U123&gt; <https://example.com|문서>");
    // Kollegium presentation.test.ts: links survive.
    expect(escapeSlackControls("<https://example.com/runbook|runbook>")).toBe(
      "<https://example.com/runbook|runbook>",
    );
    expect(escapeSlackControls("<mailto:ops@example.com|메일>")).toBe(
      "<mailto:ops@example.com|메일>",
    );
  });

  test("a date control notifies nobody and is kept", () => {
    const date = "<!date^1758500000^{date_short}|2025-09-22>";
    expect(escapeSlackControls(date)).toBe(date);
  });

  test("bare ampersands are escaped once, entities are not doubled", () => {
    expect(escapeSlackControls("R&D &amp; ops &lt;b&gt;")).toBe(
      "R&amp;D &amp; ops &lt;b&gt;",
    );
  });

  test("ordinary text, Korean and literal stars are left as written", () => {
    // Kollegium presentation.test.ts: Korean facts and literal stars.
    const text = "**수요일** 14:00에 배포합니다.\n곱셈은 2 * 3 = 6입니다. 🚀";
    expect(escapeSlackControls(text)).toBe(text);
  });

  test("a comparison that looks like a control keeps its meaning", () => {
    expect(escapeSlackControls("if a < b and c > d")).toBe(
      "if a &lt; b and c &gt; d",
    );
    expect(escapeSlackControls("a < b\nc > d")).toBe("a < b\nc > d");
  });

  test("code spans and fenced code are not touched", () => {
    // Kollegium presentation.test.ts: fenced code keeps `<@U999>`.
    const fenced =
      '코드:\n```ts\nconst marker = "**literal** <@U999> & x";\n```';
    expect(escapeSlackControls(fenced)).toBe(fenced);
    expect(escapeSlackControls("run `echo <!here>` then <!here>")).toBe(
      "run `echo <!here>` then &lt;!here&gt;",
    );
    expect(escapeSlackControls("open ``` <!here>")).toBe("open ``` <!here>");
  });
});

describe("escapeSlackControls with a policy", () => {
  test("keeps only the references the caller vouches for", () => {
    // Kollegium presentation.test.ts: trusted references.
    expect(
      escapeSlackControls(
        "Owner <@U123ABC> in <#C123ABC> <!here> and literal <@U999BAD>.",
        { userIds: ["U123ABC"], channelIds: ["C123ABC"] },
      ),
    ).toBe(
      "Owner <@U123ABC> in <#C123ABC> &lt;!here&gt; and literal &lt;@U999BAD&gt;.",
    );
    // Kollegium web-api.test.ts: explicitly trusted mentions only.
    expect(
      escapeSlackControls("Owner <@U123> and <@U999>.", { userIds: ["U123"] }),
    ).toBe("Owner <@U123> and &lt;@U999&gt;.");
  });

  test("groups and broad mentions need their own entries", () => {
    const policy = { userGroupIds: ["S1"], special: ["here"] as const };
    expect(escapeSlackControls("<!subteam^S1|@oncall> <!here>", policy)).toBe(
      "<!subteam^S1|@oncall> <!here>",
    );
    expect(escapeSlackControls("<!channel> <!subteam^S2>", policy)).toBe(
      "&lt;!channel&gt; &lt;!subteam^S2&gt;",
    );
  });

  test("a trusted id inside a nested control is still escaped", () => {
    expect(
      escapeSlackControls("<https://example.com|<@U1>>", { userIds: ["U1"] }),
    ).toBe("&lt;https://example.com|&lt;@U1&gt;>");
  });
});

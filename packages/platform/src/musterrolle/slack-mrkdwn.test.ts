import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.ts";

const ZW = "\u200B";

describe("markdownToSlackMrkdwn", () => {
  test("bold, strikethrough and headings use Slack's single markers", () => {
    expect(markdownToSlackMrkdwn("a **bold** b ~~gone~~ c")).toBe(
      "a *bold* b ~gone~ c",
    );
    expect(markdownToSlackMrkdwn("# Title\n### **Sub** ##\n## C#")).toBe(
      "*Title*\n*Sub*\n*C#*",
    );
  });

  test("a marker touching a letter gets a zero-width space so Slack still formats it", () => {
    expect(markdownToSlackMrkdwn("이 **굵게**는 앞**굵게**")).toBe(
      `이 *굵게*${ZW}는 앞${ZW}*굵게*`,
    );
    expect(markdownToSlackMrkdwn("~~취소~~다")).toBe(`~취소~${ZW}다`);
    expect(markdownToSlackMrkdwn("(**ok**).")).toBe("(*ok*).");
  });

  test("links become Slack links; unsafe destinations stay readable", () => {
    expect(markdownToSlackMrkdwn("[예시 링크](https://example.com)")).toBe(
      "<https://example.com|예시 링크>",
    );
    expect(
      markdownToSlackMrkdwn(
        '[wiki](https://en.wikipedia.org/wiki/A_(b) "t") ![img](https://x.test/i.png)',
      ),
    ).toBe(
      "<https://en.wikipedia.org/wiki/A_(b)|wiki> <https://x.test/i.png|img>",
    );
    expect(markdownToSlackMrkdwn("[https://a.test](https://a.test)")).toBe(
      "<https://a.test>",
    );
    expect(markdownToSlackMrkdwn("[x](javascript:alert(1))")).toBe(
      "x (javascript:alert(1))",
    );
    expect(markdownToSlackMrkdwn("[a|b](https://a.test)")).toBe(
      "a|b (https://a.test)",
    );
  });

  test("lists become bullets, nested by indentation", () => {
    expect(
      markdownToSlackMrkdwn(
        [
          "- one",
          "  - nested",
          "    * deeper",
          "  + back",
          "- two",
          "1. first",
          "   - under first",
          "- [ ] todo",
          "- [x] done",
        ].join("\n"),
      ),
    ).toBe(
      [
        "• one",
        "    ◦ nested",
        "        ▪ deeper",
        "    ◦ back",
        "• two",
        "1. first",
        "    ◦ under first",
        "• ☐ todo",
        "• ☑ done",
      ].join("\n"),
    );
  });

  test("a table becomes an aligned code block, wide characters counted twice", () => {
    expect(
      markdownToSlackMrkdwn(
        [
          "before",
          "| 이름 | **값** |",
          "| :--- | ---: |",
          "| alpha | `1|2` |",
          "| [link](https://a.test) | 한 |",
          "after",
        ].join("\n"),
      ),
    ).toBe(
      [
        "before",
        "```",
        "이름                  | 값",
        "----------------------+----",
        "alpha                 | 1|2",
        "link (https://a.test) | 한",
        "```",
        "after",
      ].join("\n"),
    );
  });

  test("code spans and blocks stay as they are; a fence loses only its language", () => {
    const input = [
      "`a**b**c` and `[x](https://a.test)`",
      "```ts",
      'const x = "**not bold**"; // - [y](z)',
      "# not a heading",
      "```",
      "- **브랜치:** `e2e-branch`",
    ].join("\n");
    expect(markdownToSlackMrkdwn(input)).toBe(
      [
        "`a**b**c` and `[x](https://a.test)`",
        "```",
        'const x = "**not bold**"; // - [y](z)',
        "# not a heading",
        "```",
        "• *브랜치:* `e2e-branch`",
      ].join("\n"),
    );
  });

  test("bold may wrap a code span", () => {
    expect(markdownToSlackMrkdwn("**run `x` now**")).toBe("*run `x` now*");
  });

  test("leaves text Slack already reads alone", () => {
    const slack =
      "*bold* _it_ ~s~ <https://a.test|a> > quote\n2 * 3 * 4 snake_case";
    expect(markdownToSlackMrkdwn(slack)).toBe(slack);
  });

  test("the reply from the 4620 capture", () => {
    const reply = [
      "# 변환 확인",
      "",
      "이 문장에는 **굵게** 표시가 들어 있습니다.",
      "",
      "~~취소~~",
      "",
      "[예시 링크](https://example.com)",
      "",
      "- 첫 번째 항목",
      "  - 하위 항목",
      "- 두 번째 항목",
      "",
      "| 이름 | 값 |",
      "| --- | --- |",
      "| alpha | 1 |",
      "",
      "`a**b**c`",
      "",
      "```ts",
      'const text: string = "**not bold**";',
      "```",
      "",
      "- **브랜치:** `e2e-branch`",
    ].join("\n");
    expect(markdownToSlackMrkdwn(reply)).toBe(
      [
        "*변환 확인*",
        "",
        "이 문장에는 *굵게* 표시가 들어 있습니다.",
        "",
        "~취소~",
        "",
        "<https://example.com|예시 링크>",
        "",
        "• 첫 번째 항목",
        "    ◦ 하위 항목",
        "• 두 번째 항목",
        "",
        "```",
        "이름  | 값",
        "------+---",
        "alpha | 1",
        "```",
        "",
        "`a**b**c`",
        "",
        "```",
        'const text: string = "**not bold**";',
        "```",
        "",
        "• *브랜치:* `e2e-branch`",
      ].join("\n"),
    );
  });

  test("link destinations and bare URLs keep their characters", () => {
    expect(
      markdownToSlackMrkdwn(
        "[**Open**](https://a.test/a**b**c) https://a.test/x~~y~~z <https://a.test/**k**>",
      ),
    ).toBe(
      "<https://a.test/a**b**c|*Open*> https://a.test/x~~y~~z <https://a.test/**k**>",
    );
    expect(markdownToSlackMrkdwn("# see https://a.test/**x**")).toBe(
      "*see https://a.test/**x***",
    );
  });

  test("double-backtick spans and tilde fences are code too", () => {
    expect(markdownToSlackMrkdwn("`` a **b** `` and ``x`y``")).toBe(
      "`` a **b** `` and ``x`y``",
    );
    expect(markdownToSlackMrkdwn("~~~ts\n**literal**\n~~~\n**after**")).toBe(
      "```\n**literal**\n```\n*after*",
    );
  });

  test("fences inside a fence stay as written", () => {
    const nested = "```md\n~~~\n**x** ``y``\n~~~\n```";
    expect(markdownToSlackMrkdwn(nested)).toBe(
      "```\n~~~\n**x** ``y``\n~~~\n```",
    );
  });

  test("a table keeps backticks inside its code and ends before a quote", () => {
    expect(markdownToSlackMrkdwn("| x |\n| --- |\n| ``a`b`` |\n> q | z")).toBe(
      "```\nx\n---\na`b\n```\n> q | z",
    );
  });

  test("a blank line inside a list keeps the nesting", () => {
    expect(
      markdownToSlackMrkdwn("- a\n\n  - b\n\n  text\n- c\nplain\n  - d"),
    ).toBe("• a\n\n    ◦ b\n\n  text\n• c\nplain\n• d");
  });

  test("unclosed markers stay linear on a long line", () => {
    const started = performance.now();
    const spaces = " ".repeat(50_000);
    markdownToSlackMrkdwn(
      [
        "**a ".repeat(25_000),
        "~~a ".repeat(25_000),
        `# a${spaces}x`,
        "| a |",
        `|-${spaces}x`,
        "a|b",
        `${spaces}|x`,
        "``x```".repeat(10_000),
        "~~~x\n".repeat(10_000),
      ].join("\n"),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("leaves text holding the placeholder characters untouched", () => {
    const odd = "\uE000 **x**";
    expect(markdownToSlackMrkdwn(odd)).toBe(odd);
  });
});

import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.ts";

const ZW = "\u200B";

describe("markdownToSlackMrkdwn", () => {
  test("bold, strikethrough and headings use Slack's single markers", () => {
    expect(markdownToSlackMrkdwn("a **bold** b ~~gone~~ c")).toBe(
      "a *bold* b ~gone~ c",
    );
    expect(markdownToSlackMrkdwn("# Title\n### **Sub** ##")).toBe(
      "*Title*\n*Sub*",
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

  test("leaves text holding the placeholder characters untouched", () => {
    const odd = "\uE000 **x**";
    expect(markdownToSlackMrkdwn(odd)).toBe(odd);
  });
});

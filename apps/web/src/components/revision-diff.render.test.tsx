import { describe, expect, test } from "bun:test";
import { setupDom } from "@werft-ai/ui/test-support/dom";

// The DOM has to exist before the ui kit and Testing Library load.
const testing = await setupDom();
const { render } = testing;
const { I18nProvider } = await import("../i18n/i18n.tsx");
const { RevisionDiff } = await import("./revision-diff.tsx");

function renderDiff(before: unknown, after: unknown) {
  return render(
    <I18nProvider locale="ko">
      <RevisionDiff
        before={before}
        after={after}
        beforeLabel="v1"
        afterLabel="v2"
      />
    </I18nProvider>,
  );
}

describe("RevisionDiff", () => {
  test("바뀐 줄은 줄바꿈하는 CodeBlock 안에서 추가·삭제를 읽어 주고, 표시는 읽지 않는다", () => {
    const long = "x".repeat(300);
    const { container } = renderDiff(
      { name: "a", prompt: "same" },
      { name: long, prompt: "same" },
    );
    const block = container.querySelector("[data-slot=code-block]");
    expect(block?.tagName).toBe("PRE");
    // A long line wraps instead of scrolling the page sideways.
    expect(block?.className).toContain("whitespace-pre-wrap");
    expect(block?.className).not.toContain("overflow-x-auto");
    const lines = [...(block?.querySelectorAll("[data-kind]") ?? [])];
    expect(lines.map((line) => line.getAttribute("data-kind"))).toEqual([
      "same",
      "removed",
      "added",
      "same",
      "same",
    ]);
    const [, removed, added] = lines;
    expect(removed?.querySelector(".sr-only")?.textContent).toBe("삭제: ");
    expect(added?.querySelector(".sr-only")?.textContent).toBe("추가: ");
    expect(added?.textContent).toContain(long);
    expect(removed?.className).toContain("line-through");
    // The +/- mark is drawn only; the sr-only word says it.
    expect(added?.querySelector("[aria-hidden=true]")?.textContent).toBe("+");
    // Each line ends in a newline, so copied text keeps the line breaks.
    expect(block?.textContent?.split("\n")).toHaveLength(lines.length + 1);
  });

  test("같은 카드면 CodeBlock 대신 같다고 말한다", () => {
    const { container } = renderDiff({ a: 1 }, { a: 1 });
    expect(container.querySelector("[data-slot=code-block]")).toBeNull();
    expect(container.textContent).toContain("두 버전의 카드가 같습니다.");
  });
});

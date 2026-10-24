import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Page, PageFrame } from "./page-frame.tsx";

const { render } = await setupDom();

describe("PageFrame", () => {
  test("여백 안에서 페이지 폭까지 넓어진 뒤 가운데에 놓인다", () => {
    const { container } = render(
      <PageFrame className="flex-1">
        <p>본문</p>
      </PageFrame>,
    );
    const frame = container.querySelector('[data-slot="page-frame"]');
    for (const gutter of [
      "p-4",
      "pt-6",
      "md:px-6",
      "md:pt-[var(--ap-space-page-top)]",
      "flex-1",
    ]) {
      expect(frame?.className.split(" ")).toContain(gutter);
    }
    const body = frame?.firstElementChild;
    expect(body?.getAttribute("data-slot")).toBe("page-frame-body");
    expect(body?.className).toContain("mx-auto");
    expect(body?.className).toContain("max-w-[var(--ap-w-page)]");
    expect(body?.textContent).toBe("본문");
  });
});

describe("Page", () => {
  test("머리 오른쪽 슬롯은 여러 요소를 순서대로 받는다", () => {
    const { getByRole, container } = render(
      <Page
        title="세션"
        description="에이전트가 맡은 일을 봅니다."
        actions={
          <>
            <button type="button">보기 전환</button>
            <button type="button">새 세션</button>
          </>
        }
      >
        <section>목록</section>
      </Page>,
    );
    expect(getByRole("heading", { level: 1, name: "세션" })).toBeTruthy();
    const header = container.querySelector('[data-slot="page-header"]');
    expect(
      [...(header?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
    ).toEqual(["보기 전환", "새 세션"]);
    const sections = header?.nextElementSibling;
    expect(sections?.className).toContain("gap-[var(--ap-space-section)]");
    expect(sections?.textContent).toBe("목록");
  });
});

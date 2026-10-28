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
      "md:px-6",
      "md:py-[var(--ap-space-page-top)]",
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

  test("폼 화면은 머리와 섹션이 함께 폼 폭에서 멈춘다", () => {
    const { container } = render(
      <Page title="워크스페이스 설정" width="form">
        <section>설정</section>
      </Page>,
    );
    const page = container.querySelector('[data-slot="page"]');
    expect(page?.getAttribute("data-width")).toBe("form");
    expect(page?.className).toContain("max-w-[var(--ap-w-form)]");
    const header = page?.querySelector('[data-slot="page-header"]');
    expect(header?.parentElement === page).toBe(true);
    expect(header?.className).not.toContain("max-w-");
    expect(header?.nextElementSibling?.className).not.toContain("max-w-");
  });

  test("목록 화면은 페이지 폭을 다 쓴다", () => {
    const { container } = render(
      <Page title="세션">
        <section>목록</section>
      </Page>,
    );
    const page = container.querySelector('[data-slot="page"]');
    expect(page?.getAttribute("data-width")).toBe("full");
    expect(page?.className).not.toContain("max-w-");
  });
});

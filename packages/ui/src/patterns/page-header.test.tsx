import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { PageHeader } from "./page-header.tsx";

const { render } = await setupDom();

describe("PageHeader", () => {
  test("제목은 페이지의 h1이고 설명이 그 h1의 설명으로 이어진다", () => {
    const { getByRole } = render(
      <PageHeader
        title="세션"
        description="에이전트가 맡은 일을 봅니다."
        actions={<button type="button">새로 만들기</button>}
      />,
    );
    const heading = getByRole("heading", { level: 1, name: "세션" });
    const describedBy = heading.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "에이전트가 맡은 일을 봅니다.",
    );
    expect(getByRole("button", { name: "새로 만들기" })).toBeTruthy();
  });

  test("설명이 없으면 비어 있는 설명을 가리키지 않는다", () => {
    const { getByRole, container } = render(
      <PageHeader title="설정" description="" />,
    );
    expect(
      getByRole("heading", { level: 1 }).hasAttribute("aria-describedby"),
    ).toBe(false);
    expect(container.querySelector("p")).toBeNull();
    // No empty actions box either: it would add a gap on the right.
    expect(
      container.querySelector('[data-slot="page-header"]')?.children,
    ).toHaveLength(1);
  });

  test("v35 크기 클래스를 쓴다: 제목 20/28, 설명 13/20, 아래 24", () => {
    const { container, getByRole } = render(
      <PageHeader title="홈" description="요약" />,
    );
    const header = container.querySelector('[data-slot="page-header"]');
    expect(header?.className).toContain("mb-[var(--ap-space-page-head)]");
    expect(getByRole("heading", { level: 1 }).className).toContain(
      "text-title",
    );
    expect(container.querySelector("p")?.className).toContain(
      "text-description",
    );
  });
});

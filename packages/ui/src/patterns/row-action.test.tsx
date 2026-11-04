import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { RowAction } = await import("../index.ts");

const FLOOR = "min-w-[var(--werft-row-action-button-min-width)]";

describe("RowAction", () => {
  test("기본은 28px outline 버튼이고 폭은 문구를 따르되 48px 하한을 둔다", () => {
    const { getByRole } = render(<RowAction>연결 해제</RowAction>);
    const button = getByRole("button", { name: "연결 해제" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-size")).toBe("sm");
    expect(button.className).toContain("border-border");
    expect(button.className).toContain(FLOOR);
  });

  test("danger와 default를 받는다", () => {
    const { getByRole } = render(
      <>
        <RowAction variant="danger">삭제</RowAction>
        <RowAction variant="default">시작</RowAction>
      </>,
    );
    expect(getByRole("button", { name: "삭제" }).className).toContain(
      "text-destructive",
    );
    expect(getByRole("button", { name: "시작" }).className).toContain(
      "bg-primary",
    );
  });

  test("아이콘 버튼은 icon-sm이고 하한이 없다", () => {
    const { getByRole } = render(
      <RowAction size="icon-sm" aria-label="메뉴">
        <svg aria-hidden="true" />
      </RowAction>,
    );
    const button = getByRole("button", { name: "메뉴" });
    expect(button.getAttribute("data-size")).toBe("icon-sm");
    expect(button.className).not.toContain(FLOOR);
  });

  test("링크로 그리면 type을 붙이지 않고, submit을 그대로 넘긴다", () => {
    const { getByRole } = render(
      <form>
        <RowAction asChild={true}>
          <a href="/release">릴리스</a>
        </RowAction>
        <RowAction type="submit">저장</RowAction>
      </form>,
    );
    const link = getByRole("link", { name: "릴리스" });
    expect(link.hasAttribute("type")).toBe(false);
    expect(link.className).toContain(FLOOR);
    expect(getByRole("button", { name: "저장" }).getAttribute("type")).toBe(
      "submit",
    );
  });
});

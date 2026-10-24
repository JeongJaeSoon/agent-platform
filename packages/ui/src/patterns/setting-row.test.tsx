import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Badge, Button, RowList } = await import("../index.ts");
const { Switch } = await import("../primitives/switch.tsx");
const { SettingRow } = await import("./setting-row.tsx");

function describedBy(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `missing:${id}`);
}

describe("SettingRow", () => {
  test("RowList joined 안의 <li>로 그리고 행 사이에 선을 둔다", () => {
    const { container } = render(
      <RowList variant="joined">
        <SettingRow title="Slack 연결" />
        <SettingRow title="DM 받기" />
      </RowList>,
    );
    const list = container.querySelector("ul");
    const rows = Array.from(list?.children ?? []);
    expect(rows.map((row) => row.tagName)).toEqual(["LI", "LI"]);
    expect(list?.className).toContain("[&>li]:border-b");
    expect(rows[0]?.getAttribute("data-slot")).toBe("setting-row");
  });

  test("컨트롤 하나는 제목이 이름, 설명이 설명이다", () => {
    const { getByRole } = render(
      <RowList variant="joined">
        <SettingRow
          title="DM 받기"
          badge={<Badge variant="gray">새 기능</Badge>}
          description="에이전트가 DM으로도 답합니다."
          meta={<span>마지막 변경 3분 전</span>}
          status="꺼짐"
          control={<Switch />}
        />
      </RowList>,
    );
    const control = getByRole("switch", { name: "DM 받기" });
    expect(describedBy(control)).toEqual(["에이전트가 DM으로도 답합니다."]);
  });

  test("버튼은 자기 이름을 지킨다", () => {
    const { getByRole, container } = render(
      <RowList variant="joined">
        <SettingRow
          title="워크스페이스 삭제"
          description="되돌릴 수 없습니다."
          actions={
            <Button type="button" variant="danger" size="sm">
              삭제
            </Button>
          }
        />
      </RowList>,
    );
    expect(getByRole("button").textContent).toBe("삭제");
    expect(getByRole("button", { name: "삭제" }).tagName).toBe("BUTTON");
    expect(container.querySelector("label")).toBe(null);
  });

  test("640px 아래에서는 세로로 쌓고 컨트롤을 오른쪽에, 위에서는 한 줄 가운데 정렬", () => {
    const { getByRole } = render(
      <RowList variant="joined">
        <SettingRow title="DM 받기" control={<Switch />} />
      </RowList>,
    );
    const row = getByRole("listitem");
    const rowClasses = row.className.split(" ");
    for (const name of [
      "flex-col",
      "flex-nowrap",
      "items-stretch",
      "gap-y-2",
      "gap-x-3",
      "sm:flex-row",
      "sm:items-center",
    ]) {
      expect(rowClasses).toContain(name);
    }
    expect(rowClasses).not.toContain("flex-wrap");
    expect(rowClasses).not.toContain("items-center");
    const slot = getByRole("switch").parentElement;
    const slotClasses = slot?.className.split(" ") ?? [];
    expect(slotClasses).toContain("self-end");
    expect(slotClasses).toContain("sm:self-auto");
  });
});

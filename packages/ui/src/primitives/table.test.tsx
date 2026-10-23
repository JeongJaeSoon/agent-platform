import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Button } from "./button.tsx";
import { RowLines, RowList, RowListItem } from "./row-list.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

const { render } = await setupDom();

const TOKENS = await Bun.file(
  `${import.meta.dir}/../foundations/tokens.css`,
).text();

function MembersTable() {
  return (
    <TableContainer label="구성원">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">이름</TableHead>
            <TableHead scope="col" variant="actions">
              관리
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <RowLines>
                <span>김하나</span>
                <span>hana@example.com</span>
              </RowLines>
            </TableCell>
            <TableCell variant="actions">
              <Button type="button" size="sm" aria-label="김하나 비활성화">
                비활성화
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </TableContainer>
  );
}

describe("Table", () => {
  test("프레임은 이름 있는 region이고 키보드로 닿는다", () => {
    const { getByRole } = render(<MembersTable />);
    const frame = getByRole("region", { name: "구성원" });
    expect(frame.tagName).toBe("SECTION");
    expect(frame.getAttribute("tabindex")).toBe("0");
    expect(frame.className).toContain("overflow-x-auto");
    expect(frame.className).toContain("focus-visible:outline-focus-ring");
  });

  test("행 높이 하한과 셀 padding은 --ap-row-* 토큰에서 온다", () => {
    const { container } = render(<MembersTable />);
    const head = container.querySelector("thead");
    const row = container.querySelector("tbody > tr");
    const cell = container.querySelector("td");
    const th = container.querySelector("th");
    expect(head?.className).toContain(
      "[&>tr]:h-[var(--ap-row-head-min-height)]",
    );
    expect(row?.className).toContain("h-[var(--ap-row-min-height)]");
    expect(cell?.className).toContain("py-[var(--ap-row-padding-y)]");
    expect(cell?.className).toContain("px-[calc(var(--ap-row-padding-x)/2)]");
    expect(th?.className).toContain("py-[var(--ap-row-head-padding-y)]");
    expect(TOKENS).toContain("--ap-row-min-height: 3rem;");
    expect(TOKENS).toContain("--ap-row-head-min-height: 2.5rem;");
  });

  test("actions 열은 내용 폭이고 그 안의 버튼 하한은 토큰 하나가 정한다", () => {
    const { getByRole } = render(<MembersTable />);
    const head = getByRole("columnheader", { name: "관리" });
    const button = getByRole("button", { name: "김하나 비활성화" });
    const cell = button.closest("td");
    for (const el of [head, cell]) {
      expect(el?.getAttribute("data-variant")).toBe("actions");
      expect(el?.className).toContain("w-px");
      expect(el?.className).toContain("whitespace-nowrap");
      expect(el?.className).toContain(
        "[&_[data-slot=button]]:min-w-[var(--ap-row-action-min-width)]",
      );
    }
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(TOKENS).toContain("--ap-row-action-min-width: 6rem;");
  });

  test("기본 셀에는 actions 클래스가 붙지 않는다", () => {
    const { getByRole } = render(<MembersTable />);
    const name = getByRole("cell", { name: /김하나/ });
    expect(name.getAttribute("data-variant")).toBe("default");
    expect(name.className).not.toContain("w-px");
  });

  test("호출자 className이 같은 축의 유틸리티를 이긴다", () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <TableCell className="py-1">값</TableCell>
          </tr>
        </tbody>
      </table>,
    );
    const classes = container.querySelector("td")?.className.split(" ");
    expect(classes).toContain("py-1");
    expect(classes).not.toContain("py-[var(--ap-row-padding-y)]");
  });
});

describe("RowList", () => {
  test("separate는 행마다 카드, joined는 한 카드와 행 사이 선이다", () => {
    const { getAllByRole } = render(
      <>
        <RowList>
          <RowListItem>하나</RowListItem>
        </RowList>
        <RowList variant="joined">
          <RowListItem>둘</RowListItem>
        </RowList>
      </>,
    );
    const [separate, joined] = getAllByRole("list");
    expect(separate?.getAttribute("data-variant")).toBe("separate");
    expect(separate?.className).toContain("[&>li]:rounded-card");
    expect(joined?.getAttribute("data-variant")).toBe("joined");
    expect(joined?.className).toContain("[&>li]:border-b");
    expect(joined?.className).toContain("rounded-card");
  });

  test("행은 행 높이 하한을 지키고 좁으면 줄을 바꾼다", () => {
    const { getByRole } = render(
      <RowList>
        <RowListItem>하나</RowListItem>
      </RowList>,
    );
    const item = getByRole("listitem");
    expect(item.className).toContain("min-h-[var(--ap-row-min-height)]");
    expect(item.className).toContain("flex-wrap");
  });
});

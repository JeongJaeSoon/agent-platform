import { describe, expect, test } from "bun:test";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import {
  RowLines,
  RowList,
  RowListItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

const { render } = await setupDom();

describe("Table · RowList", () => {
  test("머리글과 칸이 행 토큰을 쓰고 열 머리글 이름이 남는다", () => {
    const { getByRole, getAllByRole } = render(
      <TableContainer label="구성원 표">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">이름</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Dana</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>,
    );
    expect(getByRole("region", { name: "구성원 표" }).tabIndex).toBe(0);
    expect(getByRole("columnheader", { name: "이름" }).className).toContain(
      "py-[var(--ap-row-head-padding-y)]",
    );
    const [, row] = getAllByRole("row");
    expect(row?.className).toContain("h-[var(--ap-row-min-height)]");
    const cell = getAllByRole("cell")[0];
    expect(cell?.className).toContain("py-[var(--ap-row-padding-y)]");
    expect(cell?.className).toContain("align-middle");
  });

  test("목록 행과 두 줄 칸이 같은 여백과 줄 간격을 쓴다", () => {
    const { getByRole } = render(
      <RowList variant="joined">
        <RowListItem>
          <RowLines>
            <span>research</span>
            <span>slug</span>
          </RowLines>
        </RowListItem>
      </RowList>,
    );
    const item = getByRole("listitem");
    expect(item.className).toContain("min-h-[var(--ap-row-min-height)]");
    expect(item.className).toContain("py-[var(--ap-row-padding-y)]");
    expect(item.className).toContain("px-[var(--ap-row-padding-x)]");
    expect(item.querySelector("[data-slot=row-lines]")?.className).toContain(
      "gap-[var(--ap-row-line-gap)]",
    );
    expect(getByRole("list").getAttribute("data-variant")).toBe("joined");
  });
});

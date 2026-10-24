import { describe, expect, test } from "bun:test";
import { setupDom } from "@werft-ai/ui/test-support/dom";

const { render } = await setupDom();
// After setupDom: the toolbar loads @werft-ai/ui, whose Radix decides at
// import time whether a DOM exists.
const { SegmentedControl, SegmentedControlItem } = await import("@werft-ai/ui");
const { ListToolbar } = await import("./list-toolbar.tsx");

function Filter() {
  return (
    <SegmentedControl aria-label="분류" value="all" onValueChange={() => {}}>
      <SegmentedControlItem value="all" count={3}>
        전체
      </SegmentedControlItem>
    </SegmentedControl>
  );
}

describe("ListToolbar", () => {
  test("분류 → 검색 → 표시방식 순으로 놓고 검색은 260px로 고정한다", () => {
    const { container, getByRole } = render(
      <ListToolbar
        filter={<Filter />}
        search={{ "aria-label": "찾기", type: "search" }}
        view={<button type="button">표</button>}
      />,
    );
    const order = [
      ...container.querySelectorAll("[role=radio], input, button"),
    ].map((node) => node.getAttribute("aria-label") ?? node.textContent);
    expect(order).toEqual(["전체 3", "찾기", "표"]);
    const wrapper = getByRole("searchbox").parentElement;
    expect(wrapper?.dataset.slot).toBe("search-input");
    expect(wrapper?.className).toContain("sm:w-[260px]");
    expect(wrapper?.className).toContain("max-w-none");
  });

  test("검색도 표시방식도 없으면 오른쪽 묶음을 그리지 않는다", () => {
    const { container } = render(<ListToolbar filter={<Filter />} />);
    expect(
      container.querySelector('[data-slot="list-toolbar-end"]'),
    ).toBeNull();
  });
});

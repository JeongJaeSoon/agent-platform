import { describe, expect, test } from "bun:test";
import { type JSX, useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
// Radix Popover portals only when it found a DOM at import time.
const { FilterMenu } = await import("./filter-menu.tsx");

const RELATIONS = [
  { value: "all", label: "모든 관계" },
  { value: "started", label: "내가 시작" },
  { value: "shared", label: "공유받음" },
];

function Relation({
  initial = "all",
  onPick,
}: {
  readonly initial?: string;
  readonly onPick?: (value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <FilterMenu
      label="관계"
      options={RELATIONS}
      value={value}
      onValueChange={(next) => {
        onPick?.(next);
        setValue(next);
      }}
    />
  );
}

describe("FilterMenu", () => {
  test("거르지 않으면 이름만 보이고 값은 읽히기만 한다", () => {
    const { getByRole } = render(<Relation />);
    const chip = getByRole("button", { name: "관계 모든 관계" });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.hasAttribute("data-filtered")).toBe(false);
    expect(
      chip.querySelector('[data-slot="filter-menu-value"]')?.className,
    ).toBe("sr-only");
  });

  test("거르면 값이 보이고 칩이 채워진다", () => {
    const { getByRole } = render(<Relation initial="started" />);
    const chip = getByRole("button", { name: "관계 내가 시작" });
    expect(chip.hasAttribute("data-filtered")).toBe(true);
    expect(chip.className.split(" ")).toContain("bg-active");
  });

  test("32px 컨트롤 높이·모서리·입력 테두리다", () => {
    const { getByRole } = render(<Relation />);
    const chip = getByRole("button").className.split(" ");
    for (const name of [
      "h-[var(--ap-control-height)]",
      "rounded-control",
      "border-input",
      "focus-visible:outline-2",
    ]) {
      expect(chip).toContain(name);
    }
    expect(chip).not.toContain("border-border");
  });

  test("열면 지금 값에 포커스가 가고 고르면 닫히며 칩으로 돌아온다", async () => {
    const picked: string[] = [];
    const { getByRole, queryByRole } = render(
      <Relation onPick={(value) => picked.push(value)} />,
    );
    const user = await setupUser();
    await user.click(getByRole("button", { name: "관계 모든 관계" }));
    const dialog = await waitFor(() => getByRole("dialog", { name: "관계" }));
    const current = getByRole("button", { name: "모든 관계" });
    expect(current.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(document.activeElement === current).toBe(true));
    expect(dialog.contains(current)).toBe(true);

    await user.keyboard("{ArrowDown}");
    const started = getByRole("button", { name: "내가 시작" });
    expect(document.activeElement === started).toBe(true);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(
      document.activeElement === getByRole("button", { name: "공유받음" }),
    ).toBe(true);
    await user.keyboard("{Enter}");

    expect(picked).toEqual(["shared"]);
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    const chip = getByRole("button", { name: "관계 공유받음" });
    await waitFor(() => expect(document.activeElement === chip).toBe(true));
  });

  test("지금 값을 다시 고르면 닫기만 한다", async () => {
    const picked: string[] = [];
    const { getByRole, queryByRole } = render(
      <Relation initial="started" onPick={(value) => picked.push(value)} />,
    );
    const user = await setupUser();
    await user.click(getByRole("button", { name: "관계 내가 시작" }));
    await user.click(
      await waitFor(() => getByRole("button", { name: "내가 시작" })),
    );
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
    expect(picked).toEqual([]);
  });

  test("Escape로 닫는다", async () => {
    const { getByRole, queryByRole } = render(<Relation />);
    const user = await setupUser();
    await user.click(getByRole("button", { name: "관계 모든 관계" }));
    await waitFor(() => getByRole("dialog"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(queryByRole("dialog")).toBeNull());
  });

  test("두 진입점에서 같은 부품을 내보낸다", async () => {
    const root = await import("../index.ts");
    const patterns = await import("./index.ts");
    expect(root.FilterMenu === FilterMenu).toBe(true);
    expect(patterns.FilterMenu === FilterMenu).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
const { NativeSelect, NativeSelectOption } = await import(
  "./native-select.tsx"
);
const { Input } = await import("./input.tsx");

describe("Input·NativeSelect v4 여백", () => {
  test("입력은 좌우 12px·위아래 0이고 네 변 테두리가 border-input이다", () => {
    const { getByRole } = render(<Input aria-label="이름" />);
    const classes = getByRole("textbox", { name: "이름" }).className.split(" ");
    expect(classes).toContain("px-3");
    expect(classes).toContain("py-0");
    expect(classes).not.toContain("py-1");
    expect(classes).toContain("border-input");
    expect(classes).not.toContain("border-b-input");
    expect(classes).toContain("h-[var(--ap-control-height)]");
  });

  test("select는 오른쪽 40px(글자→화살표 12px), sm은 28px 높이에 12px 글자, 화살표는 text-3이다", () => {
    const { getByRole } = render(
      <>
        <NativeSelect aria-label="관계">
          <NativeSelectOption value="all">전체</NativeSelectOption>
        </NativeSelect>
        <NativeSelect aria-label="미리보기" size="sm">
          <NativeSelectOption value="ko">한국어</NativeSelectOption>
        </NativeSelect>
      </>,
    );
    const select = getByRole("combobox", { name: "관계" });
    const classes = select.className.split(" ");
    for (const name of [
      "px-3",
      "py-0",
      "pr-10",
      "border-input",
      "text-control",
    ]) {
      expect(classes).toContain(name);
    }
    expect(classes).not.toContain("pr-7");
    expect(select.getAttribute("data-size")).toBe("default");
    const sm = getByRole("combobox", { name: "미리보기" });
    expect(sm.getAttribute("data-size")).toBe("sm");
    expect(sm.className.split(" ")).toEqual(
      expect.arrayContaining([
        "data-[size=sm]:h-[var(--ap-control-height-sm)]",
        "data-[size=sm]:text-caption",
      ]),
    );
    const icon = select.parentElement?.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    // pr-10 (40px) leaves 12px between the text and a 16px icon 12px in.
    expect(icon?.getAttribute("class")?.split(" ")).toEqual(
      expect.arrayContaining(["text-subtle-foreground", "size-4", "right-3"]),
    );
  });
});

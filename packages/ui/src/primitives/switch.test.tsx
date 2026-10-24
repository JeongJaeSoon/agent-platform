import { describe, expect, mock, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";
import { Field, FieldDescription, FieldLabel } from "./field.tsx";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Switch } = await import("./switch.tsx");

describe("Switch", () => {
  test("클릭과 Space로 켜고 끄며 새 값을 알린다", async () => {
    const user = await setupUser();
    const onCheckedChange = mock((_checked: boolean) => {});
    const { getByRole } = render(
      <Switch aria-label="게스트 허용" onCheckedChange={onCheckedChange} />,
    );
    const control = getByRole("switch", { name: "게스트 허용" });
    expect(control.getAttribute("aria-checked")).toBe("false");

    await user.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(onCheckedChange.mock.calls).toEqual([[true]]);

    await user.keyboard(" ");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(onCheckedChange.mock.calls).toEqual([[true], [false]]);
  });

  test("controlled에서 부모가 값을 바꾸지 않으면 그대로다", async () => {
    const user = await setupUser();
    const onCheckedChange = mock((_checked: boolean) => {});
    const { getByRole } = render(
      <Switch
        aria-label="게스트 허용"
        checked={true}
        onCheckedChange={onCheckedChange}
      />,
    );
    const control = getByRole("switch");
    await user.click(control);
    expect(onCheckedChange.mock.calls).toEqual([[false]]);
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  test("비활성이면 포커스도 토글도 되지 않는다", async () => {
    const user = await setupUser();
    const onCheckedChange = mock((_checked: boolean) => {});
    const { getByRole } = render(
      <>
        <Switch
          aria-label="게스트 허용"
          disabled={true}
          onCheckedChange={onCheckedChange}
        />
        <button type="button">다음</button>
      </>,
    );
    const control = getByRole("switch");
    await user.tab();
    expect(document.activeElement === getByRole("button")).toBe(true);
    await user.click(control);
    expect(onCheckedChange.mock.calls).toEqual([]);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  test("Tab 정지는 하나다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <>
        <Switch aria-label="게스트 허용" />
        <button type="button">다음</button>
      </>,
    );
    await user.tab();
    expect(document.activeElement === getByRole("switch")).toBe(true);
    await user.tab();
    expect(document.activeElement === getByRole("button")).toBe(true);
  });

  test("Field 안에서는 FieldLabel이 이름, FieldDescription이 설명이다", () => {
    const { getByRole } = render(
      <Field orientation="horizontal">
        <Switch />
        <FieldLabel>게스트 허용</FieldLabel>
        <FieldDescription>Slack 게스트도 에이전트를 부릅니다.</FieldDescription>
      </Field>,
    );
    const control = getByRole("switch", { name: "게스트 허용" });
    const ids = (control.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "Slack 게스트도 에이전트를 부릅니다.",
    ]);
  });

  test("outline은 focus-visible에만 있고 크기는 20×36이다", () => {
    const { getByRole } = render(<Switch aria-label="게스트 허용" />);
    const classes = getByRole("switch").className.split(" ");
    expect(classes.filter((c) => /outline|ring/.test(c)).sort()).toEqual([
      "focus-visible:outline-2",
      "focus-visible:outline-focus-ring",
      "focus-visible:outline-offset-2",
    ]);
    expect(classes).toContain("h-5");
    expect(classes).toContain("w-9");
  });
});

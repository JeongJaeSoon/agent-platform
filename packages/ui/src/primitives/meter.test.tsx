import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Meter } from "./meter.tsx";

const { render } = await setupDom();

function share(container: HTMLElement): string {
  const mark = container.querySelector<HTMLElement>("[data-slot=meter-mark]");
  return mark?.style.getPropertyValue("--meter-share") ?? "";
}

describe("Meter", () => {
  test("이름과 값을 meter로 읽힌다", () => {
    const { getByRole } = render(<Meter value={7} max={10} label="slot" />);
    const meter = getByRole("meter", { name: "slot" });
    expect(meter.getAttribute("aria-valuenow")).toBe("7");
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("10");
  });

  test("막대 폭은 값의 비율이다", () => {
    const { container } = render(<Meter value={7} max={10} label="slot" />);
    expect(share(container)).toBe("70%");
  });

  test("값 0과 음수는 0%, max를 넘으면 100%로 잘린다", () => {
    for (const [value, expected] of [
      [0, "0%"],
      [-3, "0%"],
      [10, "100%"],
      [25, "100%"],
    ] as const) {
      const { container, getByRole, unmount } = render(
        <Meter value={value} max={10} label="slot" />,
      );
      expect(share(container)).toBe(expected);
      const now = Number(getByRole("meter").getAttribute("aria-valuenow"));
      expect(now).toBeGreaterThanOrEqual(0);
      expect(now).toBeLessThanOrEqual(10);
      unmount();
    }
  });

  test("max가 0이면 빈 막대다", () => {
    const { container } = render(<Meter value={3} max={0} label="slot" />);
    expect(share(container)).toBe("0%");
  });

  test("inline은 4px 회색, 기본은 8px 진한 막대, caution은 주의 색이다", () => {
    const classesOf = (element: Element | null) =>
      (element?.className ?? "").split(" ");
    const base = render(<Meter value={1} max={2} label="a" />).container;
    expect(classesOf(base.querySelector("[data-slot=meter]"))).toContain("h-2");
    expect(classesOf(base.querySelector("[data-slot=meter-mark]"))).toContain(
      "bg-chart-mark-active",
    );
    const inline = render(
      <Meter value={1} max={2} label="b" size="inline" />,
    ).container;
    expect(classesOf(inline.querySelector("[data-slot=meter]"))).toContain(
      "h-1",
    );
    expect(classesOf(inline.querySelector("[data-slot=meter-mark]"))).toContain(
      "bg-chart-mark",
    );
    const caution = render(
      <Meter value={1} max={2} label="c" tone="caution" />,
    ).container;
    expect(
      classesOf(caution.querySelector("[data-slot=meter-mark]")),
    ).toContain("bg-(color:--ap-tone-caution-fg)");
  });
});

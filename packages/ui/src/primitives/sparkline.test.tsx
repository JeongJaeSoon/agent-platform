import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Sparkline } from "./sparkline.tsx";

const { render } = await setupDom();

function linePoints(container: HTMLElement): string[] {
  return (
    container.querySelector("polyline")?.getAttribute("points") ?? ""
  ).split(" ");
}

describe("Sparkline", () => {
  test("이름이 있는 이미지로 읽힌다", () => {
    const { getByRole } = render(
      <Sparkline values={[1, 2, 3]} label="일자별 세션 수" />,
    );
    expect(getByRole("img", { name: "일자별 세션 수" }).tagName).toBe("svg");
  });

  test("가장 작은 값은 아래, 가장 큰 값은 위에 그린다", () => {
    const { container } = render(<Sparkline values={[2, 6, 4]} label="a" />);
    expect(linePoints(container)).toEqual([
      "0.00,30.00",
      "50.00,2.00",
      "100.00,16.00",
    ]);
  });

  test("점이 하나여도 폭 전체에 선을 그린다", () => {
    const { container } = render(<Sparkline values={[5]} label="a" />);
    expect(linePoints(container)).toEqual(["0.00,30.00", "100.00,30.00"]);
    expect(container.querySelector("polygon")).not.toBeNull();
  });

  test("값이 모두 같으면 아래쪽 평평한 선이다", () => {
    const { container } = render(<Sparkline values={[3, 3, 3]} label="a" />);
    expect(linePoints(container)).toEqual([
      "0.00,30.00",
      "50.00,30.00",
      "100.00,30.00",
    ]);
  });

  test("값이 없으면 선 없이 이름만 남는다", () => {
    const { container, getByRole } = render(
      <Sparkline values={[]} label="a" />,
    );
    expect(container.querySelector("polyline")).toBeNull();
    expect(getByRole("img", { name: "a" })).toBeTruthy();
  });
});

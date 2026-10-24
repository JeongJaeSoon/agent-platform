import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { BarChart, niceMax } = await import("./bar-chart.tsx");

const DATA = Array.from({ length: 30 }, (_, i) => ({
  x: `2026-10-${String(i + 1).padStart(2, "0")}`,
  y: 10 + i,
  partial: i === 12,
}));
const day = (x: string) => `${Number(x.slice(5, 7))}/${Number(x.slice(8))}`;
const tip = (d: { x: string; y: number }) => `${day(d.x)} · $${d.y}`;
const TIPS = DATA.map(tip);

function Chart() {
  return (
    <>
      <button type="button">앞</button>
      <BarChart
        data={DATA}
        label="일자별 비용, 30일"
        formatX={day}
        formatY={(y) => `$${Math.round(y)}`}
        formatTip={tip}
      />
    </>
  );
}

describe("BarChart", () => {
  test("차트 전체가 Tab 정지 하나이고 마지막 막대에서 시작한다", async () => {
    const user = await setupUser();
    const { getAllByRole, getByRole } = render(<Chart />);
    getByRole("button", { name: "앞" }).focus();
    await user.tab();
    const bars = getAllByRole("button").slice(1);
    expect(bars).toHaveLength(30);
    expect(bars.filter((bar) => bar.tabIndex === 0)).toHaveLength(1);
    expect(document.activeElement === bars[29]).toBe(true);
    await user.tab();
    expect(bars.includes(document.activeElement as HTMLElement)).toBe(false);
  });

  test("화살표·Home·End만으로 모든 막대의 툴팁을 읽는다", async () => {
    const user = await setupUser();
    const { getAllByRole, getByRole, container } = render(<Chart />);
    const bars = getAllByRole("button").slice(1);
    await user.click(getByRole("button", { name: "앞" }));
    await user.tab();
    expect(document.activeElement === bars[29]).toBe(true);
    const tipText = () =>
      container.querySelector("[data-slot=bar-chart-tip]")?.textContent;
    expect(tipText()).toBe(TIPS[29]);
    await user.keyboard("{Home}");
    const seen = [tipText()];
    for (let i = 1; i < 30; i += 1) {
      await user.keyboard("{ArrowRight}");
      seen.push(tipText());
    }
    expect(seen).toEqual(DATA.map(tip));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement === bars[29]).toBe(true);
    await user.keyboard("{End}{ArrowLeft}");
    expect(document.activeElement === bars[28]).toBe(true);
  });

  test("막대의 이름은 툴팁 문장이고, 보고 안 된 날은 빗금으로 표시한다", () => {
    const { getAllByRole } = render(<Chart />);
    const bars = getAllByRole("button").slice(1);
    expect(bars.map((bar) => bar.getAttribute("aria-label"))).toEqual(
      DATA.map(tip),
    );
    expect(
      bars
        .filter((bar) => bar.dataset.partial !== undefined)
        .map((bar) => bar.getAttribute("aria-label")),
    ).toEqual([TIPS[12] ?? ""]);
  });

  test("y 눈금 다섯 개와 x 라벨 처음·가운데·끝", () => {
    const { container } = render(<Chart />);
    const [yAxis, , xAxis] = [
      ...(container.querySelector("[data-slot=bar-chart]")?.children ?? []),
    ];
    expect([...(yAxis?.children ?? [])].map((n) => n.textContent)).toEqual([
      "$40",
      "$30",
      "$20",
      "$10",
      "$0",
    ]);
    expect([...(xAxis?.children ?? [])].map((n) => n.textContent)).toEqual([
      "10/1",
      "10/16",
      "10/30",
    ]);
  });

  test("compact는 포커스 없는 이미지 하나이고 이름에 요약을 담는다", () => {
    const { getByRole, queryAllByRole } = render(
      <BarChart
        compact
        data={DATA.slice(0, 14)}
        label="Bash 일자별 호출, 최근 14일, 합계 287번"
        formatX={day}
      />,
    );
    expect(
      getByRole("img", { name: "Bash 일자별 호출, 최근 14일, 합계 287번" }),
    ).toBeTruthy();
    expect(queryAllByRole("button")).toHaveLength(0);
  });

  test("y축 꼭대기는 가장 큰 값을 2·4·6… × 10의 거듭제곱으로 올린다", () => {
    expect(niceMax([56.4])).toBe(60);
    expect(niceMax([80])).toBe(80);
    expect(niceMax([81])).toBe(100);
    expect(niceMax([0])).toBe(1);
    expect(niceMax([])).toBe(1);
  });
});

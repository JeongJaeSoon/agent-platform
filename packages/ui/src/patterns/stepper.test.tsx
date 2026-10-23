import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";
import { Stepper, type StepperStep } from "./stepper.tsx";

const { render } = await setupDom();

const STEPS: StepperStep[] = [
  { id: "basics", label: "기본 정보" },
  { id: "model", label: "모델" },
  { id: "tools", label: "도구", disabled: true },
  { id: "review", label: "검토" },
];

describe("Stepper", () => {
  test("현재 단계만 aria-current=step이고 지난 단계는 완료로 읽힌다", () => {
    const { getByRole, getAllByRole } = render(
      <Stepper label="만들기 단계" steps={STEPS} currentStepId="model" />,
    );
    expect(getByRole("navigation", { name: "만들기 단계" })).toBeTruthy();
    const items = getAllByRole("listitem");
    expect(items.map((item) => item.dataset.state)).toEqual([
      "complete",
      "current",
      "upcoming",
      "upcoming",
    ]);
    const current = [...document.querySelectorAll('[aria-current="step"]')];
    expect(current.map((node) => node.textContent)).toEqual(["2모델"]);
    expect(items[0]?.textContent).toContain("완료");
    // Display only: nothing to tab to.
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  test("Tab은 현재 단계에 서고 화살표·Home·End가 고를 수 있는 단계 사이를 돈다", async () => {
    const user = await setupUser();
    const { getByRole } = render(
      <Stepper
        label="만들기 단계"
        steps={STEPS}
        currentStepId="model"
        onStepSelect={() => {}}
      />,
    );
    const step = (name: RegExp) => getByRole("button", { name });
    await user.tab();
    expect(document.activeElement).toBe(step(/모델/));
    await user.keyboard("{ArrowRight}");
    // 도구 is disabled, so focus skips to 검토.
    expect(document.activeElement).toBe(step(/검토/));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(step(/기본 정보/));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(step(/검토/));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(step(/기본 정보/));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(step(/검토/));
    expect(
      [...document.querySelectorAll("button")].map((button) => button.tabIndex),
    ).toEqual([-1, -1, -1, 0]);
  });

  test("화면이 현재 단계를 바꾸면 Tab 진입점도 새 현재 단계로 간다", async () => {
    const user = await setupUser();
    const props = {
      label: "만들기 단계",
      steps: STEPS,
      onStepSelect: () => {},
    };
    const { getByRole, rerender } = render(
      <>
        <button type="button">앞</button>
        <Stepper {...props} currentStepId="basics" />
      </>,
    );
    rerender(
      <>
        <button type="button">앞</button>
        <Stepper {...props} currentStepId="model" />
      </>,
    );
    getByRole("button", { name: "앞" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(getByRole("button", { name: /모델/ }));
  });

  test("Enter로 단계를 고르면 onStepSelect가 그 id를 받는다", async () => {
    const user = await setupUser();
    const onStepSelect = mock((_id: string) => {});
    function Harness() {
      const [current, setCurrent] = useState("model");
      return (
        <Stepper
          label="만들기 단계"
          steps={STEPS}
          currentStepId={current}
          onStepSelect={(id) => {
            onStepSelect(id);
            setCurrent(id);
          }}
        />
      );
    }
    const { getByRole } = render(<Harness />);
    await user.tab();
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(onStepSelect).toHaveBeenCalledWith("basics");
    expect(
      getByRole("button", { name: /기본 정보/ }).getAttribute("aria-current"),
    ).toBe("step");
  });
});

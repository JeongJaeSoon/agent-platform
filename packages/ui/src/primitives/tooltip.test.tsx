import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { fireEvent, render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Tooltip, TooltipContent, TooltipTrigger } = await import(
  "./tooltip.tsx"
);

function renderTooltip() {
  const result = render(
    <div>
      <Tooltip>
        <TooltipTrigger asChild={true}>
          <button type="button" aria-label="일시정지">
            ||
          </button>
        </TooltipTrigger>
        <TooltipContent>실행을 잠시 멈춥니다</TooltipContent>
      </Tooltip>
      <button type="button">다른 곳</button>
    </div>,
  );
  const trigger = result.getByRole("button", { name: "일시정지" });
  const elsewhere = result.getByRole("button", { name: "다른 곳" });
  const note = () => document.querySelector('[data-slot="popover-content"]');
  return { ...result, trigger, elsewhere, note };
}

describe("Tooltip", () => {
  test("닫혀 있어도 aria-describedby가 가리키는 글자가 설명이다", () => {
    const { trigger, note } = renderTooltip();
    expect(note()).toBeNull();
    const id = trigger.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")?.textContent).toBe(
      "실행을 잠시 멈춥니다",
    );
    expect(trigger.hasAttribute("aria-expanded")).toBe(false);
    expect(trigger.getAttribute("aria-haspopup")).toBe("false");
  });

  test("hover로 열리고 포인터가 나가면 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, elsewhere, note } = renderTooltip();
    await user.hover(trigger);
    await waitFor(() =>
      expect(note()?.textContent).toBe("실행을 잠시 멈춥니다"),
    );
    expect(note()?.getAttribute("role")).toBe("tooltip");
    await user.hover(elsewhere);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("포인터가 트리거에서 내용으로 옮겨 가면 열린 채다", async () => {
    const user = await setupUser();
    const { trigger, note } = renderTooltip();
    await user.hover(trigger);
    await waitFor(() => expect(note()).not.toBeNull());
    // user-event leaves relatedTarget empty; React derives leave from it.
    fireEvent.pointerOut(trigger, {
      pointerType: "mouse",
      relatedTarget: note(),
    });
    expect(note()).not.toBeNull();
    fireEvent.pointerOut(note() as Element, {
      pointerType: "mouse",
      relatedTarget: trigger,
    });
    expect(note()).not.toBeNull();
    fireEvent.pointerOut(note() as Element, {
      pointerType: "mouse",
      relatedTarget: document.body,
    });
    await waitFor(() => expect(note()).toBeNull());
  });

  test("Tab focus로 열려도 포커스는 트리거에 남고, Esc로 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, note } = renderTooltip();
    await user.tab();
    expect(document.activeElement === trigger).toBe(true);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(document.activeElement === trigger).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
    expect(document.activeElement === trigger).toBe(true);
  });

  test("blur로 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, elsewhere, note } = renderTooltip();
    await user.tab();
    await waitFor(() => expect(note()).not.toBeNull());
    await user.tab();
    expect(document.activeElement === elsewhere).toBe(true);
    expect(document.activeElement === trigger).toBe(false);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("누르기로 열리고, 다시 누르면 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, note } = renderTooltip();
    // A touch press: no hover, and the click after its focus must not close it.
    await user.pointer([{ keys: "[TouchA]", target: trigger }]);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(document.activeElement === trigger).toBe(true);
    await user.pointer([{ keys: "[TouchA]", target: trigger }]);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("마우스 클릭으로 열린 채 남고, 바깥 누르기로 닫힌다", async () => {
    const user = await setupUser();
    const { trigger, elsewhere, note } = renderTooltip();
    await user.click(trigger);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(document.activeElement === trigger).toBe(true);
    await user.pointer([{ keys: "[TouchA]", target: elsewhere }]);
    await waitFor(() => expect(note()).toBeNull());
  });

  test("open을 넘기면 그 값대로 열려 있다", () => {
    render(
      <Tooltip open={true}>
        <TooltipTrigger asChild={true}>
          <button type="button">설명</button>
        </TooltipTrigger>
        <TooltipContent>열린 설명</TooltipContent>
      </Tooltip>,
    );
    expect(
      document.querySelector('[data-slot="popover-content"]')?.textContent,
    ).toBe("열린 설명");
  });
});

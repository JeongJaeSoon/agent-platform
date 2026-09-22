import { describe, expect, test } from "bun:test";
import { useState } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; loaded any earlier, its
// portals silently never mount. See the note in test-support/dom.ts.
const { ConfirmDialog } = await import("./confirm-dialog.tsx");
const { DestructiveActionDialog } = await import(
  "./destructive-action-dialog.tsx"
);

function ConfirmHarness({
  onConfirm = () => {},
  busy = false,
}: {
  onConfirm?: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="세션을 일시정지할까요?"
      consequence="실행 중인 턴은 마무리하고, 대기 중인 지시는 그대로 남습니다."
      confirmLabel="일시정지"
      onConfirm={onConfirm}
      busy={busy}
    />
  );
}

function DestructiveHarness({
  onConfirm = () => {},
}: {
  onConfirm?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <DestructiveActionDialog
      open={open}
      onOpenChange={setOpen}
      title="에이전트를 해고할까요?"
      consequence="카드와 release가 비활성화되고, 진행 중인 세션은 종료됩니다."
      resourceName="결제 담당"
      onConfirm={onConfirm}
    />
  );
}

function dialogOf(baseElement: Element): HTMLElement {
  const node = baseElement.querySelector("[role='dialog']");
  if (!node) throw new Error("dialog is not rendered");
  return node as HTMLElement;
}

describe("ConfirmDialog", () => {
  test("제목과 결과 설명이 접근성 이름·설명으로 이어진다", () => {
    const { baseElement } = render(<ConfirmHarness />);
    const dialog = dialogOf(baseElement);

    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(baseElement.querySelector(`#${labelledBy}`)?.textContent).toBe(
      "세션을 일시정지할까요?",
    );
    expect(baseElement.querySelector(`#${describedBy}`)?.textContent).toContain(
      "대기 중인 지시는 그대로 남습니다",
    );
  });

  test("Escape로 닫힌다", async () => {
    const user = await setupUser();
    const { baseElement } = render(<ConfirmHarness />);
    expect(baseElement.querySelector("[role='dialog']")).not.toBeNull();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(baseElement.querySelector("[role='dialog']")).toBeNull();
    });
  });

  test("포커스가 다이얼로그 밖으로 새지 않는다", async () => {
    const user = await setupUser();
    const { baseElement } = render(
      <>
        <button type="button">바깥 버튼</button>
        <ConfirmHarness />
      </>,
    );
    const dialog = dialogOf(baseElement);

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    // A full lap around the trap: focus must never land on 바깥 버튼.
    for (let index = 0; index < 6; index += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  test("확인을 누르면 알릴 뿐, 스스로 성공으로 넘어가지 않는다", async () => {
    const user = await setupUser();
    const calls: string[] = [];
    const { baseElement, getByText } = render(
      <ConfirmHarness onConfirm={() => calls.push("confirm")} />,
    );

    await user.click(getByText("일시정지"));

    expect(calls).toEqual(["confirm"]);
    // 서버 응답 전에는 열린 채로 둔다 (§1 optimistic 금지).
    expect(baseElement.querySelector("[role='dialog']")).not.toBeNull();
  });

  test("요청 중에는 확인 버튼을 잠근다", async () => {
    const user = await setupUser();
    const calls: string[] = [];
    const { getByText } = render(
      <ConfirmHarness busy={true} onConfirm={() => calls.push("confirm")} />,
    );

    const button = getByText("일시정지").closest("button");
    expect(button?.disabled).toBe(true);
    await user.click(button as HTMLButtonElement);
    expect(calls).toEqual([]);
  });
});

describe("DestructiveActionDialog", () => {
  test("이름을 정확히 입력해야 확인 버튼이 열린다", async () => {
    const user = await setupUser();
    const calls: string[] = [];
    const { baseElement, getByText } = render(
      <DestructiveHarness onConfirm={() => calls.push("confirm")} />,
    );

    const confirm = getByText("삭제").closest("button") as HTMLButtonElement;
    const input = baseElement.querySelector("input") as HTMLInputElement;

    expect(confirm.disabled).toBe(true);

    await user.type(input, "결제");
    expect(confirm.disabled).toBe(true);

    await user.type(input, " 담당");
    await waitFor(() => {
      expect(confirm.disabled).toBe(false);
    });

    await user.click(confirm);
    expect(calls).toEqual(["confirm"]);
  });

  test("matchText를 주면 그 문자열을 요구한다", async () => {
    const user = await setupUser();
    const { baseElement, getByText } = render(
      <DestructiveActionDialog
        open={true}
        onOpenChange={() => {}}
        title="세션을 종료할까요?"
        consequence="진행 중인 턴이 중단됩니다."
        resourceName="설계 검토 세션"
        matchText="ses_01J8Z5"
        onConfirm={() => {}}
      />,
    );

    const confirm = getByText("삭제").closest("button") as HTMLButtonElement;
    const input = baseElement.querySelector("input") as HTMLInputElement;

    await user.type(input, "설계 검토 세션");
    expect(confirm.disabled).toBe(true);

    await user.clear(input);
    await user.type(input, "ses_01J8Z5");
    await waitFor(() => {
      expect(confirm.disabled).toBe(false);
    });
  });

  test("위험 동작임을 색이 아닌 표기로도 남긴다", () => {
    const { baseElement } = render(<DestructiveHarness />);
    expect(dialogOf(baseElement).getAttribute("data-tone")).toBe("danger");
  });
});

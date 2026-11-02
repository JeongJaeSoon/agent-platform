import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { DisabledReason } = await import("./disabled-reason.tsx");

describe("DisabledReason", () => {
  test("비활성 버튼을 감싼 상자가 포커스·hover로 위쪽에 이유를 연다", async () => {
    const user = await setupUser();
    const result = render(
      <DisabledReason reason="자기 자신은 안 됩니다" label="나 비활성화">
        <button type="button" disabled={true}>
          비활성화
        </button>
      </DisabledReason>,
    );
    const button = result.getByRole("button", { name: "비활성화" });
    const box = button.parentElement as HTMLElement;
    const note = () => document.querySelector('[data-slot="popover-content"]');
    expect(box.dataset.slot).toBe("disabled-reason");
    expect(box.hasAttribute("type")).toBe(false);
    expect(result.getByRole("group", { name: "나 비활성화" }) === box).toBe(
      true,
    );
    expect(box.getAttribute("aria-disabled")).toBe("true");
    const description = (element: HTMLElement) =>
      document.getElementById(element.getAttribute("aria-describedby") ?? "")
        ?.textContent;
    expect(description(box)).toBe("자기 자신은 안 됩니다");
    expect(description(button)).toBe("자기 자신은 안 됩니다");
    await user.tab();
    expect(document.activeElement === box).toBe(true);
    await waitFor(() => expect(note()).not.toBeNull());
    expect(note()?.getAttribute("data-side")).toBe("top");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
    expect(document.activeElement === box).toBe(true);
    await user.hover(box);
    await waitFor(() => expect(note()).not.toBeNull());
  });
});

// The scenarios apps/web proves for ReasonButton (app.test.tsx, "권한 없는
// 버튼"), on the shared mode it moves onto.
describe('DisabledReason mode="control"', () => {
  const REASON = "sessions:recover 권한이 있어야 할 수 있습니다.";

  function Form({
    reason,
    pressed,
  }: {
    readonly reason: string | undefined;
    readonly pressed: string[];
  }) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          pressed.push("submit");
        }}
      >
        <input aria-label="이름" />
        <DisabledReason mode="control" reason={reason}>
          <button type="submit" onClick={() => pressed.push("click")}>
            복구
          </button>
        </DisabledReason>
      </form>
    );
  }

  const note = () => document.querySelector('[role="tooltip"]');
  const description = (element: HTMLElement) =>
    (element.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join("");

  test("이유가 있으면 누를 수 없게 두되 포커스는 받고, 이유는 설명으로 읽힌다", () => {
    const pressed: string[] = [];
    const { getByRole } = render(<Form reason={REASON} pressed={pressed} />);
    const button = getByRole("button", { name: "복구" });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(description(button)).toBe(REASON);
    expect(document.querySelector('[data-slot="disabled-reason"]')).toBeNull();
    expect(note()).toBeNull();
  });

  test("이유가 있으면 클릭·Enter·Space·칸에서 Enter 모두 아무 일도 없다", async () => {
    const user = await setupUser();
    const pressed: string[] = [];
    const { getByRole, getByLabelText } = render(
      <Form reason={REASON} pressed={pressed} />,
    );
    const button = getByRole("button", { name: "복구" });
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    await user.type(getByLabelText("이름"), "x{Enter}");
    expect(pressed).toEqual([]);
  });

  test("Tab으로 닿으면 이유가 보이고, Escape로 닫혀도 포커스는 버튼에 남는다", async () => {
    const user = await setupUser();
    const { getByRole, getByLabelText } = render(
      <Form reason={REASON} pressed={[]} />,
    );
    const button = getByRole("button", { name: "복구" });
    getByLabelText("이름").focus();
    await user.tab();
    expect(document.activeElement === button).toBe(true);
    await waitFor(() => expect(note()?.textContent).toBe(REASON));
    expect(note()?.getAttribute("data-side")).toBe("top");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(note()).toBeNull());
    expect(document.activeElement === button).toBe(true);
  });

  test("누르면(탭) 이유가 고정되어 열린다", async () => {
    const user = await setupUser();
    const { getByRole } = render(<Form reason={REASON} pressed={[]} />);
    await user.pointer({
      keys: "[TouchA]",
      target: getByRole("button", { name: "복구" }),
    });
    await waitFor(() => expect(note()?.textContent).toBe(REASON));
  });

  test("이유가 없으면 누를 수 있고 이유가 뜨지 않는다", async () => {
    const user = await setupUser();
    const pressed: string[] = [];
    const { getByRole } = render(<Form reason={undefined} pressed={pressed} />);
    const button = getByRole("button", { name: "복구" });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    await user.hover(button);
    expect(note()).toBeNull();
    await user.click(button);
    expect(pressed).toEqual(["click", "submit"]);
  });

  test("권한이 바뀌어도 같은 버튼이 포커스를 지킨다", async () => {
    const user = await setupUser();
    const pressed: string[] = [];
    const { getByRole, getByLabelText, rerender } = render(
      <Form reason={undefined} pressed={pressed} />,
    );
    const before = getByRole("button", { name: "복구" });
    getByLabelText("이름").focus();
    await user.tab();
    rerender(<Form reason={REASON} pressed={pressed} />);
    const withheld = getByRole("button", { name: "복구" });
    expect(withheld === before).toBe(true);
    expect(document.activeElement === before).toBe(true);
    expect(withheld.getAttribute("aria-disabled")).toBe("true");
    rerender(<Form reason={undefined} pressed={pressed} />);
    expect(getByRole("button", { name: "복구" }) === before).toBe(true);
    expect(document.activeElement === before).toBe(true);
    await user.keyboard("{Enter}");
    expect(pressed).toEqual(["click", "submit"]);
  });
});

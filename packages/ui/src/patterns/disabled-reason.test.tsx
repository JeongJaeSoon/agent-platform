import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { DisabledReason } = await import("./disabled-reason.tsx");

describe("DisabledReason", () => {
  test("비활성 버튼을 감싼 상자가 포커스·hover로 위쪽에 이유를 연다", async () => {
    const user = await setupUser();
    const result = render(
      <DisabledReason reason="자기 자신은 안 됩니다">
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
    expect(
      document.getElementById(box.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("자기 자신은 안 됩니다");
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

import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
const { CopyButton } = await import("./copy-button.tsx");

const VALUE = "ak_FAKE0000000000000000000000";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

const icon = (button: HTMLElement) =>
  button.querySelector("svg")?.getAttribute("class") ?? "";

describe("CopyButton", () => {
  test("복사하면 값을 클립보드에 쓰고 성공을 넘긴 뒤 Check와 복사됨 문구로 바뀐다", async () => {
    const results: boolean[] = [];
    const screen = render(
      <CopyButton
        value={VALUE}
        label="복사"
        copiedLabel="복사됨"
        onResult={(ok) => results.push(ok)}
      />,
    );
    const user = await setupUser();
    // After setupUser, which installs a clipboard of its own.
    const copied: string[] = [];
    const restore = stubClipboard(async (text) => {
      copied.push(text);
    });
    try {
      const button = screen.getByRole("button", { name: "복사" });
      expect(button.getAttribute("type")).toBe("button");
      expect(icon(button)).toContain("lucide-copy");
      await user.click(button);
      await waitFor(() => expect(results).toEqual([true]));
      expect(copied).toEqual([VALUE]);
      expect(button.textContent).toBe("복사됨");
      expect(button.hasAttribute("data-copied")).toBe(true);
      expect(icon(button)).toContain("lucide-check");
    } finally {
      restore();
    }
  });

  test("클립보드가 거부하면 실패를 넘기고 대체 입력칸에 포커스하며 복사 상태로 바뀌지 않는다", async () => {
    const results: boolean[] = [];
    const field = createRef<HTMLInputElement>();
    const screen = render(
      <>
        <input ref={field} readOnly value={VALUE} aria-label="키" />
        <CopyButton
          value={VALUE}
          label="복사"
          copiedLabel="복사됨"
          copiedMessage="복사됨"
          fallbackField={field}
          onResult={(ok) => results.push(ok)}
        />
      </>,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {
      throw new Error("denied");
    });
    try {
      const button = screen.getByRole("button", { name: "복사" });
      await user.click(button);
      await waitFor(() => expect(results).toEqual([false]));
      expect(document.activeElement === field.current).toBe(true);
      expect(button.textContent).toBe("복사");
      expect(icon(button)).toContain("lucide-copy");
      expect(screen.getByRole("status").textContent).toBe("");
    } finally {
      restore();
    }
  });

  test("클립보드가 없는 환경도 실패로 넘긴다", async () => {
    const results: boolean[] = [];
    const screen = render(
      <CopyButton
        value={VALUE}
        label="복사"
        onResult={(ok) => results.push(ok)}
      />,
    );
    const user = await setupUser();
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    try {
      await user.click(screen.getByRole("button", { name: "복사" }));
      await waitFor(() => expect(results).toEqual([false]));
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("아이콘만 있는 버튼은 aria-label로 이름이 고정되고 성공은 status로 알린다", async () => {
    const screen = render(
      <CopyButton
        value={VALUE}
        aria-label="키 ID 복사"
        copiedMessage="복사됨"
        variant="ghost"
        size="sm"
      />,
    );
    const user = await setupUser();
    const restore = stubClipboard(async () => {});
    try {
      const button = screen.getByRole("button", { name: "키 ID 복사" });
      expect(button.textContent).toBe("");
      const status = screen.getByRole("status");
      expect(status.tagName).toBe("OUTPUT");
      expect(status.className.split(" ")).toContain("sr-only");
      expect(status.textContent).toBe("");
      await user.click(button);
      await waitFor(() => expect(status.textContent).toBe("복사됨"));
      expect(
        screen.getByRole("button", { name: "키 ID 복사" }) === button,
      ).toBe(true);
      expect(button.textContent).toBe("");
      expect(icon(button)).toContain("lucide-check");
      expect(button.dataset.size).toBe("sm");
    } finally {
      restore();
    }
  });

  test("copiedMessage가 없으면 status 영역을 두지 않고, hideIcon이면 글자만 그린다", () => {
    const screen = render(
      <CopyButton value={VALUE} label="복사" hideIcon={true} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    const button = screen.getByRole("button", { name: "복사" });
    expect(button.querySelector("svg")).toBeNull();
  });

  test("값이 바뀌면 복사 상태가 풀리고, 바뀌기 전에 시작한 복사는 알리지 않는다", async () => {
    const results: boolean[] = [];
    const props = {
      label: "복사",
      copiedLabel: "복사됨",
      onResult: (ok: boolean) => results.push(ok),
    };
    const screen = render(<CopyButton value="first" {...props} />);
    const user = await setupUser();
    const pending: Array<() => void> = [];
    const restore = stubClipboard(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    );
    try {
      const button = screen.getByRole("button", { name: "복사" });
      await user.click(button);
      await waitFor(() => expect(pending.length).toBe(1));
      pending[0]?.();
      await waitFor(() => expect(results).toEqual([true]));
      expect(button.textContent).toBe("복사됨");

      screen.rerender(<CopyButton value="second" {...props} />);
      expect(button.textContent).toBe("복사");

      await user.click(button);
      await waitFor(() => expect(pending.length).toBe(2));
      screen.rerender(<CopyButton value="third" {...props} />);
      pending[1]?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(results).toEqual([true]);
      expect(button.textContent).toBe("복사");
    } finally {
      restore();
    }
  });
});

import { describe, expect, test } from "bun:test";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render, waitFor } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { RelativeTime } = await import("./relative-time.tsx");

const NOW = Date.parse("2026-10-24T15:14:02+09:00");
const AT = "2026-10-24T14:59:00+09:00";

describe("RelativeTime", () => {
  test("focus 가능한 <time>에 입력 ISO와 상대 글자를 그린다", () => {
    const { container } = render(
      <RelativeTime value={AT} locale="ja" now={NOW} className="meta" />,
    );
    const time = container.querySelector("time");
    expect(time?.tagName).toBe("TIME");
    expect(time?.getAttribute("datetime")).toBe(AT);
    expect(time?.tabIndex).toBe(0);
    expect(time?.textContent).toBe("15 分前");
    expect(time?.className.split(" ")).toContain("meta");
    expect(
      document.getElementById(time?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("2026年10月24日 14:59:00 GMT+9");
  });

  test("Date 입력은 ISO 문자열로 dateTime에 쓴다", () => {
    const { container } = render(
      <RelativeTime value={new Date(AT)} now={NOW} />,
    );
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-10-24T05:59:00.000Z",
    );
  });

  test("Tab focus로 정확한 시각이 열리고 포커스는 <time>에 남는다", async () => {
    const user = await setupUser();
    const { container } = render(
      <RelativeTime value={AT} locale="en" now={NOW} />,
    );
    await user.tab();
    const time = container.querySelector("time");
    expect(document.activeElement === time).toBe(true);
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]')?.textContent,
      ).toBe("October 24, 2026, 14:59:00 GMT+9"),
    );
    expect(document.activeElement === time).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).toBeNull(),
    );
  });
});

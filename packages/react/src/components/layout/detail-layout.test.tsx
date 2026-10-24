import { describe, expect, test } from "bun:test";

import { setupDom } from "@werft-ai/ui/test-support/dom";

const { render, waitFor } = await setupDom();
// After setupDom: this loads @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { DetailLayout, DetailRail, DetailRailSection } = await import(
  "./detail-layout.tsx"
);

// Happy DOM lays nothing out, so the rail's heights are set on the element
// and a new render runs the check again.
const sized = (content: Element | null, scroll: number, client: number) => {
  Object.defineProperty(content, "scrollHeight", { value: scroll });
  Object.defineProperty(content, "clientHeight", { value: client });
};

function Page() {
  return (
    <DetailLayout
      rail={
        <DetailRail label="세션 요약">
          <DetailRailSection title="운영">rows</DetailRailSection>
        </DetailRail>
      }
    >
      <h1>본문</h1>
    </DetailLayout>
  );
}

describe("DetailRail", () => {
  test("a rail taller than the screen takes a keyboard stop to scroll", async () => {
    const { container, rerender, getByRole } = render(<Page />);
    const content = container.querySelector(
      '[data-slot="detail-rail-content"]',
    );
    expect(content?.hasAttribute("tabindex")).toBe(false);
    sized(content, 900, 600);
    rerender(<Page />);
    await waitFor(() => expect(content?.getAttribute("tabindex")).toBe("0"));
    expect(getByRole("group", { name: "세션 요약" }) === content).toBe(true);
    expect(
      getByRole("complementary", { name: "세션 요약" }).contains(content),
    ).toBe(true);
  });

  test("a rail that fits takes no extra stop", () => {
    const { container, rerender } = render(<Page />);
    const content = container.querySelector(
      '[data-slot="detail-rail-content"]',
    );
    sized(content, 400, 400);
    rerender(<Page />);
    expect(content?.hasAttribute("tabindex")).toBe(false);
    expect(content?.hasAttribute("role")).toBe(false);
  });
});

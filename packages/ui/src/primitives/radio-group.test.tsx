import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { RadioGroup, RadioGroupItem } = await import("./radio-group.tsx");

describe("RadioGroupItem", () => {
  test("포인터를 올리면 테두리와 바탕이 바뀌고, 비활성은 그대로다", () => {
    const { getAllByRole } = render(
      <RadioGroup aria-label="테마" defaultValue="light">
        <RadioGroupItem value="light" aria-label="라이트" />
        <RadioGroupItem value="dark" aria-label="다크" disabled={true} />
      </RadioGroup>,
    );
    for (const radio of getAllByRole("radio")) {
      const classes = radio.className.split(" ");
      expect(classes).toContain(
        "enabled:not-focus-visible:not-aria-invalid:hover:border-foreground",
      );
      expect(classes).toContain("enabled:hover:bg-hover");
    }
  });
});

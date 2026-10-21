import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Tabs, TabsList, TabsTrigger } = await import("./tabs.tsx");

describe("Tabs", () => {
  test("밑줄은 가로 탭에서 양옆에 붙고 reduced motion에서 전환하지 않는다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const classes = getByRole("tab", { name: "개요" }).className.split(" ");
    expect(classes).toContain("motion-reduce:after:transition-none");
    expect(classes).toContain(
      "group-data-[orientation=horizontal]/tabs:after:inset-x-0",
    );
  });
});

import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";

const { render } = await setupDom();
// Radix decides at import time whether a DOM exists; see test-support/dom.ts.
const { Tabs, TabsList, TabsTrigger } = await import("./tabs.tsx");

describe("Tabs", () => {
  test("line 밑줄은 v4처럼 글자 쪽으로 8px 들어가 바닥선 위에 놓이고 reduced motion에서 전환하지 않는다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const classes = getByRole("tab", { name: "개요" }).className.split(" ");
    expect(classes).toContain("motion-reduce:after:transition-none");
    for (const name of [
      "group-data-[orientation=horizontal]/tabs:after:inset-x-2",
      "group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]",
      "group-data-[orientation=horizontal]/tabs:after:h-0.5",
      "group-data-[orientation=horizontal]/tabs:after:rounded-[1px]",
    ]) {
      expect(classes).toContain(name);
    }
  });

  test("line 목록은 탭 사이 4px, 탭은 36px·좌우 8px이고 바닥선은 호출부 몫이다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line" aria-label="세션">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = getByRole("tablist", { name: "세션" }).className.split(" ");
    for (const name of [
      "gap-1",
      "p-0",
      "group-data-[orientation=horizontal]/tabs:h-auto",
    ]) {
      expect(list).toContain(name);
    }
    expect(list).not.toContain("gap-6");
    // Callers draw the rule on a wrapper beside other controls; a second one
    // here would double it (see the session detail screen story).
    expect(list.some((name) => name.includes("border-b"))).toBe(false);
    expect(list).toContain("w-fit");
    expect(list).not.toContain("group-data-[orientation=horizontal]/tabs:h-9");
    const tab = getByRole("tab", { name: "개요" }).className.split(" ");
    for (const name of [
      "group-data-[variant=line]/tabs-list:h-9",
      "group-data-[variant=line]/tabs-list:px-2",
      "group-data-[variant=line]/tabs-list:py-0",
      "group-data-[variant=line]/tabs-list:border-0",
    ]) {
      expect(tab).toContain(name);
    }
  });

  test("기본 variant 목록은 그대로다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList aria-label="보기">
          <TabsTrigger value="a">개요</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const list = getByRole("tablist", { name: "보기" });
    expect(list.getAttribute("data-variant")).toBe("default");
    const classes = list.className.split(" ");
    expect(classes).toContain("bg-muted");
    expect(classes).toContain("p-[3px]");
    expect(classes).toContain("group-data-[orientation=horizontal]/tabs:h-9");
    expect(classes).not.toContain("border-b");
  });

  test("개수는 이름 뒤에 읽히고 0도 그리며 countLabel이 있으면 그 문장을 읽는다", () => {
    const { getByRole } = render(
      <Tabs defaultValue="a">
        <TabsList variant="line">
          <TabsTrigger value="a" count={12}>
            산출물
          </TabsTrigger>
          <TabsTrigger value="b" count={0}>
            요청
          </TabsTrigger>
          <TabsTrigger value="c" count={3} countLabel="3개 실행 중">
            실행 중
          </TabsTrigger>
          <TabsTrigger value="d">정보</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const counted = getByRole("tab", { name: "산출물 12" });
    expect(counted.textContent).toBe("산출물 12");
    const number = counted.querySelector('[data-slot="item-count"]');
    expect(number?.previousSibling?.textContent).toBe(" ");
    expect(number?.className.split(" ")).toContain("tabular-nums");
    expect(
      getByRole("tab", { name: "요청 0" }).querySelector(
        '[data-slot="item-count"]',
      )?.textContent,
    ).toBe("0");
    const labelled = getByRole("tab", { name: "실행 중 3개 실행 중" });
    expect(
      labelled
        .querySelector('[data-slot="item-count"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      getByRole("tab", { name: "정보" }).querySelector(
        '[data-slot="item-count"]',
      ),
    ).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { createRef } from "react";

import { setupDom } from "../test-support/dom.ts";
import { Text, type TextProps } from "./text.tsx";

const { render } = await setupDom();

function classesOf(props: TextProps): string[] {
  const { container, unmount } = render(<Text {...props}>글</Text>);
  const classes = (
    container.querySelector("[data-slot=text]")?.className ?? ""
  ).split(" ");
  unmount();
  return classes;
}

describe("Text", () => {
  test("variant마다 v4 크기·줄·색 유틸리티를 고른다", () => {
    const cases: [TextProps["variant"], string[]][] = [
      ["body", ["text-control", "leading-5", "text-foreground"]],
      ["sub", ["text-control", "leading-5", "text-muted-foreground"]],
      ["meta", ["text-caption", "leading-normal", "text-subtle-foreground"]],
      ["2xs", ["text-2xs", "text-subtle-foreground"]],
    ];
    for (const [variant, expected] of cases) {
      const classes = classesOf({ variant });
      for (const name of expected) expect(classes).toContain(name);
      expect(classes).toContain("font-normal");
      // v4 "body" is 13px; the `text-body` key is 14px.
      expect(classes).not.toContain("text-body");
    }
    expect(classesOf({})).toEqual(classesOf({ variant: "body" }));
  });

  test("as가 요소를 고르고 기본은 p다", () => {
    for (const as of ["p", "span", "div"] as const) {
      const { container, unmount } = render(<Text as={as}>글</Text>);
      expect(container.querySelector("[data-slot=text]")?.tagName).toBe(
        as.toUpperCase(),
      );
      unmount();
    }
    const { container } = render(<Text>글</Text>);
    expect(container.querySelector("[data-slot=text]")?.tagName).toBe("P");
  });

  test("weight=medium은 500과 본문 색으로 variant 색을 대신한다", () => {
    const classes = classesOf({ variant: "meta", weight: "medium" });
    for (const name of ["font-medium", "text-foreground", "text-caption"])
      expect(classes).toContain(name);
    for (const name of ["font-normal", "text-subtle-foreground"])
      expect(classes).not.toContain(name);
  });

  test("mono는 12px mono로 크기만 바꾸고 variant의 줄과 색을 둔다", () => {
    const classes = classesOf({ variant: "sub", mono: true });
    for (const name of [
      "font-mono",
      "text-caption",
      "leading-5",
      "text-muted-foreground",
      "font-normal",
    ])
      expect(classes).toContain(name);
    expect(classes).not.toContain("text-control");

    const meta = classesOf({ variant: "meta", mono: true });
    expect(meta).toContain("leading-normal");
  });

  test("numeric·truncate를 함께 붙인다", () => {
    const classes = classesOf({ numeric: true, truncate: true });
    for (const name of ["tabular-nums", "truncate", "min-w-0"])
      expect(classes).toContain(name);
    const plain = classesOf({});
    for (const name of ["tabular-nums", "truncate", "font-mono"])
      expect(plain).not.toContain(name);
  });

  test("className을 합치고 ref·나머지 props를 요소에 넘긴다", () => {
    const ref = createRef<HTMLParagraphElement>();
    const { container } = render(
      <Text ref={ref} title="전체" className="mt-1 text-caption">
        글
      </Text>,
    );
    const text = container.querySelector("[data-slot=text]");
    expect(ref.current === text).toBe(true);
    expect(text?.getAttribute("title")).toBe("전체");
    const classes = (text?.className ?? "").split(" ");
    expect(classes).toContain("mt-1");
    expect(classes).toContain("text-caption");
    expect(classes).not.toContain("text-control");
    expect(classes).toContain("leading-5");
  });

  test("호출자의 크기 클래스가 variant의 줄을 지우지 않고, 호출자의 leading은 그것을 대신한다", () => {
    const meta = classesOf({ variant: "meta", className: "text-caption" });
    expect(meta).toContain("leading-normal");
    const own = classesOf({ variant: "meta", className: "leading-5" });
    expect(own).toContain("leading-5");
    expect(own).not.toContain("leading-normal");
    const shorthand = classesOf({ className: "text-lg/8" });
    expect(shorthand).toContain("text-lg/8");
    expect(shorthand).not.toContain("leading-5");
  });

  test("변형이 붙은 leading과 색 투명도는 기본 줄을 지우지 않는다", () => {
    const responsive = classesOf({
      variant: "meta",
      className: "md:leading-5",
    });
    expect(responsive).toContain("md:leading-5");
    expect(responsive).toContain("leading-normal");
    const faded = classesOf({ className: "text-foreground/80" });
    expect(faded).toContain("leading-5");
  });

  test("span으로 자를 때는 잘릴 상자를 만든다", () => {
    const span = classesOf({ as: "span", truncate: true });
    for (const name of ["truncate", "inline-block", "max-w-full"])
      expect(span).toContain(name);
    const p = classesOf({ truncate: true });
    expect(p).not.toContain("inline-block");
  });
});

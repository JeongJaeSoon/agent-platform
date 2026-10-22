import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { Card, CardTitle } from "./card.tsx";

const { render } = await setupDom();

describe("Button", () => {
  test("variant가 의미 변수 유틸리티로 그려진다", () => {
    const { getByRole } = render(
      <Button type="button" variant="destructive">
        삭제
      </Button>,
    );
    const button = getByRole("button", { name: "삭제" });
    expect(button.className).toContain("bg-destructive");
    expect(button.className).toContain("text-destructive-foreground");
    expect(button.className).toContain("text-control");
  });

  test("호출자 className이 같은 축의 variant 유틸리티를 이긴다", () => {
    const { getByRole } = render(
      <Button type="button" className="px-2">
        좁게
      </Button>,
    );
    const classes = getByRole("button").className.split(" ");
    expect(classes).toContain("px-2");
    expect(classes).not.toContain("px-4");
  });

  test("asChild면 버튼을 겹치지 않고 자식 링크에 모양을 입힌다", () => {
    const { container } = render(
      <Button asChild={true} variant="outline">
        <a href="/agents">에이전트</a>
      </Button>,
    );
    const link = container.querySelector("a");
    expect(container.querySelector("button")).toBeNull();
    expect(link?.getAttribute("data-slot")).toBe("button");
    expect(link?.className).toContain("border-input");
  });

  test("motion-reduce에서 transition을 끈다", () => {
    const { getByRole } = render(<Button type="button">확인</Button>);
    expect(getByRole("button").className).toContain(
      "motion-reduce:transition-none",
    );
  });
});

describe("Badge · Card", () => {
  test("data-slot으로 자기 자리를 밝힌다", () => {
    const { container } = render(
      <Card>
        <CardTitle>결제 담당</CardTitle>
        <Badge variant="outline">초안</Badge>
      </Card>,
    );
    expect(
      [...container.querySelectorAll("[data-slot]")].map((node) =>
        node.getAttribute("data-slot"),
      ),
    ).toEqual(["card", "card-title", "badge"]);
  });
});

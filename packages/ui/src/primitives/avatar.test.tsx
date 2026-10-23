import { describe, expect, test } from "bun:test";

import { setupDom } from "../test-support/dom.ts";
import { Avatar } from "./avatar.tsx";

const { render } = await setupDom();

describe("Avatar", () => {
  test("이름 없이 그리면 장식으로 숨는다", () => {
    const { container } = render(<Avatar initials="JS" />);
    const avatar = container.querySelector("[data-slot=avatar]");
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.getAttribute("role")).toBeNull();
    expect(avatar?.textContent).toBe("JS");
  });

  test("label을 주면 그 이름의 이미지로 읽힌다", () => {
    const { getByRole } = render(<Avatar initials="JS" label="정재순" />);
    const avatar = getByRole("img", { name: "정재순" });
    expect(avatar.getAttribute("aria-hidden")).toBeNull();
    expect(avatar.textContent).toBe("JS");
  });

  test("기본은 24px 원, 11px 글자, active 바탕이다", () => {
    const { container } = render(<Avatar initials="A" />);
    const classes = (
      container.querySelector("[data-slot=avatar]")?.className ?? ""
    ).split(" ");
    for (const name of [
      "size-6",
      "text-2xs",
      "rounded-full",
      "bg-active",
      "text-muted-foreground",
      "font-semibold",
    ])
      expect(classes).toContain(name);
  });

  test("lg·square·tone이 32px·6px 모서리·아바타 토큰을 고른다", () => {
    const { container } = render(
      <Avatar initials="A" size="lg" shape="square" tone={3} />,
    );
    const classes = (
      container.querySelector("[data-slot=avatar]")?.className ?? ""
    ).split(" ");
    for (const name of [
      "size-8",
      "text-caption",
      "rounded-control",
      "bg-(color:--ap-avatar-3-bg)",
      "text-(color:--ap-avatar-3-fg)",
    ])
      expect(classes).toContain(name);
    for (const name of ["size-6", "text-2xs", "rounded-full", "bg-active"])
      expect(classes).not.toContain(name);
  });
});

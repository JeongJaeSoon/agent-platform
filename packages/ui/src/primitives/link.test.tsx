import { describe, expect, test } from "bun:test";
import { type ComponentProps, createRef, type JSX } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { Link, SkipLink } = await import("./link.tsx");

// The shape of TanStack Router's <Link>: `to` becomes href, it adds its own
// class and attributes, and it forwards the ref to its <a>.
function RouterLink({
  to,
  className,
  ...props
}: Omit<ComponentProps<"a">, "href"> & { readonly to: string }): JSX.Element {
  return (
    <a
      href={to}
      className={["router-link", className].filter(Boolean).join(" ")}
      data-status="active"
      {...props}
    />
  );
}

describe("Link", () => {
  test("기본은 링크색에 hover 밑줄과 font-medium이다", () => {
    const { getByRole } = render(<Link href="/agents">에이전트</Link>);
    const classes = getByRole("link", { name: "에이전트" }).className.split(
      " ",
    );
    expect(classes).toContain("text-link");
    expect(classes).toContain("hover:underline");
    expect(classes).toContain("underline-offset-2");
    expect(classes).toContain("font-medium");
    expect(classes).not.toContain("underline");
  });

  test("always는 늘 밑줄이고 굵기는 문장을 따른다", () => {
    const { getByRole } = render(
      <Link href="/login" underline="always">
        로그인
      </Link>,
    );
    const classes = getByRole("link").className.split(" ");
    expect(classes).toContain("underline");
    expect(classes).not.toContain("font-medium");
  });

  test("focus-visible 윤곽선을 부품 클래스로 갖는다", () => {
    const { getByRole } = render(<Link href="/">홈</Link>);
    const classes = getByRole("link").className.split(" ");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-offset-2");
    expect(classes).toContain("focus-visible:outline-focus-ring");
  });

  test("asChild면 라우터 링크의 <a> 하나에 className·href·ref를 합친다", () => {
    const outer = createRef<HTMLAnchorElement>();
    const { container } = render(
      <Link asChild={true} ref={outer} className="truncate">
        <RouterLink to="/teams/1">운영팀</RouterLink>
      </Link>,
    );
    const anchors = container.querySelectorAll("a");
    expect(anchors.length).toBe(1);
    const anchor = anchors[0] as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("/teams/1");
    expect(anchor.getAttribute("data-slot")).toBe("link");
    expect(anchor.getAttribute("data-status")).toBe("active");
    const classes = anchor.className.split(" ");
    expect(classes).toContain("router-link");
    expect(classes).toContain("text-link");
    expect(classes).toContain("truncate");
    expect(outer.current === anchor).toBe(true);
  });

  test("새 탭 링크는 호출자 rel을 지키면서 noopener noreferrer를 붙인다", () => {
    const { getByRole } = render(
      <Link href="https://example.com" target="_blank" rel="nofollow">
        문서
      </Link>,
    );
    const rel = getByRole("link").getAttribute("rel")?.split(" ") ?? [];
    expect(rel.sort()).toEqual(["nofollow", "noopener", "noreferrer"]);
  });

  test("asChild 자식이 새 탭이어도 rel을 보장한다", () => {
    const { container } = render(
      <Link asChild={true}>
        {/* biome-ignore lint/security/noBlankTarget: Link adds the missing rel */}
        <a href="https://example.com" target="_blank" rel="external">
          문서
        </a>
      </Link>,
    );
    const rel = container.querySelector("a")?.getAttribute("rel") ?? "";
    expect(rel.split(" ").sort()).toEqual([
      "external",
      "noopener",
      "noreferrer",
    ]);
  });

  test("같은 탭 링크에는 rel을 더하지 않는다", () => {
    const { getByRole } = render(<Link href="/agents">에이전트</Link>);
    expect(getByRole("link").hasAttribute("rel")).toBe(false);
  });

  test("새 탭 안내 문구가 접근 이름에 들어간다", () => {
    const { getByRole } = render(
      <Link
        href="https://example.com"
        target="_blank"
        newTabLabel="(새 탭에서 열림)"
      >
        문서
      </Link>,
    );
    expect(getByRole("link", { name: "문서 (새 탭에서 열림)" })).toBeTruthy();
  });

  test("asChild에서도 안내 문구가 자식 <a> 안에 들어간다", () => {
    const { container, getByRole } = render(
      <Link asChild={true} newTabLabel="(새 탭에서 열림)">
        <a href="https://example.com" target="_blank" rel="noreferrer">
          문서
        </a>
      </Link>,
    );
    expect(container.querySelectorAll("a").length).toBe(1);
    expect(getByRole("link", { name: "문서 (새 탭에서 열림)" })).toBeTruthy();
  });

  test("같은 탭 링크에는 안내 문구를 넣지 않는다", () => {
    const { getByRole } = render(
      <Link href="/agents" newTabLabel="(새 탭에서 열림)">
        에이전트
      </Link>,
    );
    expect(getByRole("link").textContent).toBe("에이전트");
  });
});

describe("SkipLink", () => {
  test("평소에는 화면 밖이고 포커스를 받으면 제자리로 온다", () => {
    const { getByRole } = render(<SkipLink href="#main">본문으로</SkipLink>);
    const classes = getByRole("link").className.split(" ");
    expect(classes).toContain("-translate-y-[200%]");
    expect(classes).toContain("focus:translate-y-0");
    expect(classes).toContain("focus-visible:outline-focus-ring");
  });

  test("Tab 첫 포커스가 스킵 링크에 가고, 누르면 본문으로 포커스가 간다", async () => {
    const user = await setupUser();
    const mainId = "main";
    const { getByRole } = render(
      <div>
        <SkipLink href={`#${mainId}`}>본문으로</SkipLink>
        <a href="/agents">에이전트</a>
        <main id={mainId} tabIndex={-1} />
      </div>,
    );
    await user.tab();
    expect(
      document.activeElement === getByRole("link", { name: "본문으로" }),
    ).toBe(true);
    await user.keyboard("{Enter}");
    expect(document.activeElement === getByRole("main")).toBe(true);
  });
});

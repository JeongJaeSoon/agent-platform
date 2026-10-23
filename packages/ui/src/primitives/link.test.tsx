import { describe, expect, test } from "bun:test";
import {
  type ComponentProps,
  createRef,
  type JSX,
  type ReactNode,
} from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { Link, SkipLink } = await import("./link.tsx");

// The shape of TanStack Router's <Link>: `to` becomes href, it adds its own
// class and attributes, forwards the ref to its <a>, and its children may be
// a function of the link's state.
function RouterLink({
  to,
  className,
  children,
  ...props
}: Omit<ComponentProps<"a">, "href" | "children"> & {
  readonly to: string;
  readonly children?:
    | ReactNode
    | ((state: { readonly isActive: boolean }) => ReactNode);
}): JSX.Element {
  return (
    <a
      href={to}
      className={["router-link", className].filter(Boolean).join(" ")}
      data-status="active"
      {...props}
    >
      {typeof children === "function" ? children({ isActive: true }) : children}
    </a>
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

  test("기본 variant에는 chevron이 없다", () => {
    const { getByRole } = render(<Link href="/teams/1">운영팀</Link>);
    expect(getByRole("link").querySelector("svg")).toBeNull();
  });

  test("table은 평소 밑줄 없이 chevron을 붙이고 hover·focus에 밑줄을 긋는다", () => {
    const { getByRole } = render(
      <Link href="/teams/1" variant="table">
        운영팀
      </Link>,
    );
    const link = getByRole("link", { name: "운영팀" });
    const classes = link.className.split(" ");
    expect(classes).toContain("no-underline");
    expect(classes).toContain("hover:underline");
    expect(classes).toContain("focus-visible:underline");
    expect(classes).toContain("font-medium");
    expect(classes).toContain("text-link");
    const icon = link.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("class")).toContain("size-4");
    expect(link.lastElementChild === icon).toBe(true);
  });

  test("more는 13px 글자 끝에 숨긴 14px 화살표를 붙인다", () => {
    const { getByRole } = render(
      <Link href="/sessions" variant="more">
        전체 보기
      </Link>,
    );
    const link = getByRole("link", { name: "전체 보기" });
    const classes = link.className.split(" ");
    expect(classes).toContain("inline-flex");
    expect(classes).toContain("gap-1");
    expect(classes).toContain("text-control");
    expect(classes).toContain("text-link");
    const icon = link.querySelector("svg");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("class")).toContain("lucide-arrow-right");
    expect(icon?.getAttribute("class")).toContain("size-3.5");
    expect(icon?.getAttribute("stroke-width")).toBe("1.5");
    expect(link.lastElementChild === icon).toBe(true);
  });

  test("table은 underline=always를 주어도 평소 밑줄이 없다", () => {
    const { getByRole } = render(
      <Link href="/teams/1" variant="table" underline="always">
        운영팀
      </Link>,
    );
    const classes = getByRole("link").className.split(" ");
    expect(classes).not.toContain("underline");
    expect(classes).toContain("no-underline");
  });

  test("asChild 라우터 링크에서도 chevron과 새 탭 문구가 <a> 하나 안에 들어간다", () => {
    const { container, getByRole } = render(
      <Link asChild={true} variant="table" newTabLabel="(새 탭)">
        <RouterLink to="/teams/1" target="_blank" rel="noreferrer">
          {({ isActive }) => (isActive ? "현재 팀" : "팀")}
        </RouterLink>
      </Link>,
    );
    expect(container.querySelectorAll("a").length).toBe(1);
    const link = getByRole("link", { name: "현재 팀 (새 탭)" });
    expect(link.querySelectorAll("svg").length).toBe(1);
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

  test("asChild 라우터 링크의 함수형 children을 그대로 넘긴다", () => {
    const { getByRole } = render(
      <Link asChild={true}>
        <RouterLink to="/teams">
          {({ isActive }) => (isActive ? "현재 팀" : "팀")}
        </RouterLink>
      </Link>,
    );
    expect(getByRole("link").textContent).toBe("현재 팀");
  });

  test("함수형 children 뒤에도 새 탭 안내 문구가 붙는다", () => {
    const { getByRole } = render(
      <Link asChild={true} newTabLabel="(새 탭에서 열림)">
        <RouterLink to="/docs" target="_blank" rel="noreferrer">
          {({ isActive }) => (isActive ? "현재 문서" : "문서")}
        </RouterLink>
      </Link>,
    );
    expect(
      getByRole("link", { name: "현재 문서 (새 탭에서 열림)" }),
    ).toBeTruthy();
  });

  test("asChild에서 Link와 자식의 rel 토큰을 모두 지킨다", () => {
    const { getByRole } = render(
      <Link asChild={true} target="_blank" rel="nofollow">
        <a href="https://example.com" rel="external">
          문서
        </a>
      </Link>,
    );
    const rel = getByRole("link").getAttribute("rel") ?? "";
    expect(rel.split(" ").sort()).toEqual([
      "external",
      "nofollow",
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

  test("target 대소문자와 관계없이 새 탭으로 다룬다", () => {
    const { getAllByRole } = render(
      <>
        <Link href="https://example.com" target="_BLANK" newTabLabel="(새 탭)">
          직접
        </Link>
        <Link asChild={true}>
          <a href="https://example.com" target="_Blank">
            자식
          </a>
        </Link>
      </>,
    );
    const [direct, child] = getAllByRole("link");
    for (const link of [direct, child]) {
      expect(link?.getAttribute("rel")?.split(" ").sort()).toEqual([
        "noopener",
        "noreferrer",
      ]);
    }
    expect(direct?.textContent).toBe("직접(새 탭)");
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

  test("인코딩된 fragment도 대상을 찾는다", async () => {
    const user = await setupUser();
    const mainId = "본문 영역";
    const { getByRole } = render(
      <div>
        <SkipLink href={`#${encodeURIComponent(mainId)}`}>본문으로</SkipLink>
        <main id={mainId} tabIndex={-1} />
      </div>,
    );
    await user.click(getByRole("link"));
    expect(document.activeElement === getByRole("main")).toBe(true);
  });

  test("호출자가 막은 클릭에서는 포커스를 옮기지 않는다", async () => {
    const user = await setupUser();
    const mainId = "main";
    const { getByRole } = render(
      <div>
        <SkipLink
          href={`#${mainId}`}
          onClick={(event) => event.preventDefault()}
        >
          본문으로
        </SkipLink>
        <main id={mainId} tabIndex={-1} />
      </div>,
    );
    await user.click(getByRole("link"));
    expect(document.activeElement === getByRole("main")).toBe(false);
  });
});

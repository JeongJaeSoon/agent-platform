import { describe, expect, mock, test } from "bun:test";
import type { ComponentProps, JSX, ReactNode } from "react";

import { setupDom, setupUser } from "../test-support/dom.ts";

const { render } = await setupDom();
const { LinkTab, LinkTabs } = await import("./link-tabs.tsx");

// The shape of TanStack Router's <Link>: `to` becomes href, it adds its own
// class, and its children may be a function of the link's state.
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
      {...props}
    >
      {typeof children === "function" ? children({ isActive: true }) : children}
    </a>
  );
}

function statusTabs(current: string) {
  const tabs = [
    { status: "", label: "전체", count: 12 },
    { status: "running", label: "실행 중", count: 3 },
    { status: "needs_input", label: "답변 대기", count: 0 },
    { status: "done", label: "끝남" },
  ];
  return (
    <LinkTabs aria-label="세션 상태">
      {tabs.map((tab) => (
        <LinkTab
          key={tab.status}
          href={tab.status ? `?status=${tab.status}` : "?"}
          current={tab.status === current}
          count={tab.count}
        >
          {tab.label}
        </LinkTab>
      ))}
    </LinkTabs>
  );
}

describe("LinkTabs", () => {
  test("이름 있는 nav 안의 링크 목록이고 tab 역할은 없다", () => {
    const { getByRole, getAllByRole, queryAllByRole } = render(
      statusTabs("running"),
    );
    const nav = getByRole("navigation", { name: "세션 상태" });
    expect(nav.tagName).toBe("NAV");
    expect(getByRole("list").parentElement === nav).toBe(true);
    expect(getAllByRole("listitem")).toHaveLength(4);
    expect(getAllByRole("link")).toHaveLength(4);
    expect(queryAllByRole("tab")).toHaveLength(0);
    expect(queryAllByRole("tablist")).toHaveLength(0);
  });

  test("지금 탭만 aria-current=page이다", () => {
    const { getAllByRole } = render(statusTabs("running"));
    const current = getAllByRole("link").filter(
      (link) => link.getAttribute("aria-current") !== null,
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("aria-current")).toBe("page");
    expect(current[0]?.getAttribute("href")).toBe("?status=running");
  });

  test("개수는 이름 뒤에 읽히고 0도 그리며 없으면 배지가 없다", () => {
    const { getByRole } = render(statusTabs(""));
    expect(getByRole("link", { name: "전체 12" })).toBeTruthy();
    // Browsers join an inline badge to the label without a space; Testing
    // Library's name computation adds one, so the text is checked too.
    expect(getByRole("link", { name: "실행 중 3" }).textContent).toBe(
      "실행 중 3",
    );
    const zero = getByRole("link", { name: "답변 대기 0" });
    expect(zero.querySelector('[data-slot="badge"]')?.textContent).toBe("0");
    const none = getByRole("link", { name: "끝남" });
    expect(none.querySelector('[data-slot="badge"]')).toBeNull();
  });

  test("큰 수도 그대로 그린다", () => {
    const { getByRole } = render(
      <LinkTabs aria-label="세션 상태">
        <LinkTab href="?" count={123456}>
          전체
        </LinkTab>
      </LinkTabs>,
    );
    const link = getByRole("link", { name: "전체 123456" });
    expect(link.querySelector('[data-slot="badge"]')?.textContent).toBe(
      "123456",
    );
  });

  test("countLabel이 있으면 숫자 대신 그 문장을 읽는다", () => {
    const { getByRole } = render(
      <LinkTabs aria-label="세션 상태">
        <LinkTab href="?status=running" count={3} countLabel="3개 실행 중">
          실행 중
        </LinkTab>
      </LinkTabs>,
    );
    const link = getByRole("link", { name: "실행 중 3개 실행 중" });
    const badge = link.querySelector('[data-slot="badge"]');
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(badge?.textContent).toBe("3");
  });

  test("asChild는 넘긴 라우터 링크를 그 자리에 그리고 href·onClick·모양을 지킨다", async () => {
    const onClick = mock((event: { preventDefault(): void }) =>
      event.preventDefault(),
    );
    const { getByRole } = render(
      <LinkTabs aria-label="API 키 종류">
        <LinkTab asChild current count={2}>
          <RouterLink to="/api-keys" onClick={onClick}>
            {({ isActive }) => (isActive ? "개인 키" : "?")}
          </RouterLink>
        </LinkTab>
        <LinkTab asChild>
          <RouterLink to="/api-keys/service">서비스 키</RouterLink>
        </LinkTab>
      </LinkTabs>,
    );
    const link = getByRole("link", { name: "개인 키 2" });
    const listItem = getByRole("list").firstElementChild;
    expect(link.tagName).toBe("A");
    expect(link.parentElement === listItem).toBe(true);
    expect(link.getAttribute("href")).toBe("/api-keys");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.getAttribute("data-slot")).toBe("link-tab");
    const classes = link.className.split(" ");
    expect(classes).toContain("router-link");
    expect(classes).toContain("border-b-2");
    await (await setupUser()).click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
    const other = getByRole("link", { name: "서비스 키" });
    expect(other.hasAttribute("aria-current")).toBe(false);
  });

  test("KeyScreenNav와 같은 치수 클래스와 focus-visible 윤곽을 쓴다", () => {
    const { getByRole } = render(statusTabs("running"));
    const list = getByRole("list").className.split(" ");
    expect(list).toContain("gap-6");
    expect(list).toContain("border-b");
    const classes = getByRole("link", { name: "실행 중 3" }).className.split(
      " ",
    );
    for (const name of [
      "-mb-px",
      "border-b-2",
      "border-transparent",
      "py-2",
      "text-control",
      "text-muted-foreground",
      "no-underline!",
      "hover:text-foreground",
      "aria-[current=page]:border-foreground",
      "aria-[current=page]:font-semibold",
      "aria-[current=page]:text-foreground",
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-focus-ring",
    ]) {
      expect(classes).toContain(name);
    }
    // Link's own colour and weight would change the tab's look.
    expect(classes).not.toContain("text-link");
    expect(classes).not.toContain("font-medium");
    // Room for the outline inside the scroll clip, but no negative right
    // margin: that would widen the page past a parent with no padding.
    const nav = getByRole("navigation").className.split(" ");
    expect(nav).toContain("overflow-x-auto");
    expect(nav.filter((name) => /^-m[rx]?-/.test(name))).toEqual([]);
    expect(list).toContain("pr-1");
  });

  test("탭 순서는 링크 순서다", async () => {
    const { getAllByRole } = render(statusTabs("running"));
    const user = await setupUser();
    const order: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      order.push(document.activeElement?.getAttribute("href") ?? "");
    }
    expect(order).toEqual(
      getAllByRole("link").map((link) => link.getAttribute("href") ?? ""),
    );
  });

  test("두 진입점에서 같은 부품을 내보낸다", async () => {
    const root = await import("../index.ts");
    const patterns = await import("./index.ts");
    expect(root.LinkTabs === LinkTabs).toBe(true);
    expect(root.LinkTab === LinkTab).toBe(true);
    expect(patterns.LinkTabs === LinkTabs).toBe(true);
    expect(patterns.LinkTab === LinkTab).toBe(true);
  });
});

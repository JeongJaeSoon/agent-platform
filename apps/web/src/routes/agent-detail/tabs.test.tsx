import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../../test-support/fake-agents.ts";
import { json, me, memberMe } from "../../test-support/fake-api.ts";
import { appHarness } from "../../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const meOk = { "GET /v1/auth/me": () => json(200, me()) };
const DETAIL = `/agents/${AGENT_ID}`;

const selected = () =>
  screen.getByRole("tab", { selected: true }).textContent ?? "";
const visiblePanel = () => screen.getByRole("tabpanel");
const tabIn = (history: { location: { search: string } }) =>
  new URLSearchParams(history.location.search).get("tab");

describe("에이전트 상세 탭", () => {
  test("개요·카드·배포·관리자 탭이 있고, 화살표로 옮기면 주소의 tab이 따라간다", async () => {
    const { history } = renderAt(DETAIL, {
      ...meOk,
      ...agentServer().routes,
    });
    const user = await setupUser();
    const list = await screen.findByRole("tablist", { name: "에이전트 상세" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["개요", "카드", "배포", "관리자"]);
    expect(selected()).toBe("개요");
    expect(tabIn(history)).toBeNull();
    // Only the chosen panel is in the accessibility tree.
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);

    await user.click(screen.getByRole("tab", { name: "개요" }));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(selected()).toBe("카드"));
    expect(document.activeElement?.textContent).toBe("카드");
    expect(tabIn(history)).toBe("card");
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(selected()).toBe("배포"));
    expect(tabIn(history)).toBe("release");
    await user.keyboard("{End}");
    await waitFor(() => expect(selected()).toBe("관리자"));
    expect(tabIn(history)).toBe("admins");
    await user.click(screen.getByRole("tab", { name: "개요" }));
    await waitFor(() => expect(tabIn(history)).toBeNull());
    // Tab leaves the tab list for the panel instead of walking the tabs.
    // (happy-dom keeps controls inside hidden panels focusable, so this is
    // checked from the first panel; browsers skip hidden ones.)
    await user.tab();
    expect(document.activeElement === visiblePanel()).toBe(true);
  });

  test("주소의 tab으로 다시 열면 그 탭이고, 탭 이동은 뒤로 가기 기록을 쌓지 않는다", async () => {
    const server = agentServer();
    const { history } = renderAt("/agents", { ...meOk, ...server.routes });
    const user = await setupUser();
    history.push(`${DETAIL}?tab=release`);
    await waitFor(() => expect(selected()).toBe("배포"));
    expect(
      within(visiblePanel()).getByRole("heading", { name: "release" }),
    ).toBeDefined();

    await user.click(screen.getByRole("tab", { name: "카드" }));
    await user.click(screen.getByRole("tab", { name: "관리자" }));
    expect(tabIn(history)).toBe("admins");
    history.push("/");
    await waitFor(() => expect(history.location.pathname).toBe("/"));
    history.back();
    await waitFor(() => expect(selected()).toBe("관리자"));
    history.back();
    await waitFor(() => expect(history.location.pathname).toBe("/agents"));
  });

  test("모르는 tab 값은 개요로 연다", async () => {
    renderAt(`${DETAIL}?tab=secrets`, { ...meOk, ...agentServer().routes });
    await screen.findByRole("tablist");
    expect(selected()).toBe("개요");
  });

  test("다른 탭에 다녀와도 저장하지 않은 카드 입력은 남는다", async () => {
    renderAt(`${DETAIL}?tab=card`, { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const instructions = await screen.findByLabelText("지시 사항");
    await user.clear(instructions);
    await user.type(instructions, "아직 저장하지 않은 지시.");
    await user.click(screen.getByRole("tab", { name: "배포" }));
    await user.click(screen.getByRole("tab", { name: "카드" }));
    expect(
      (screen.getByLabelText("지시 사항") as HTMLTextAreaElement).value,
    ).toBe("아직 저장하지 않은 지시.");
  });

  test("다른 탭으로 옮긴 뒤 끝난 저장은 카드 탭을 다시 열고 결과로 포커스를 옮긴다", async () => {
    const server = agentServer();
    const patch = server.routes[`PATCH /v1/agents/${AGENT_ID}`];
    let respond: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      respond = resolve;
    });
    const { history } = renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...server.routes,
      [`PATCH /v1/agents/${AGENT_ID}`]: async (request: Request) => {
        await gate;
        return patch ? patch(request) : json(500, {});
      },
    });
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "저장" }));
    await user.click(screen.getByRole("tab", { name: "개요" }));
    await waitFor(() => expect(selected()).toBe("개요"));
    respond();
    const saved = await screen.findByText(/저장했습니다/);
    await waitFor(() => expect(selected()).toBe("카드"));
    expect(visiblePanel().contains(saved)).toBe(true);
    await waitFor(() => expect(tabIn(history)).toBe("card"));
    expect(document.activeElement?.contains(saved)).toBe(true);
  });

  test("개요의 켜기까지 단계는 아직 켜지지 않았다고 하고 배포 탭으로 잇는다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "켜기까지" })
    ).closest("section") as HTMLElement;
    expect(
      await within(section).findByText(/아직 켜지지 않았습니다/),
    ).toBeDefined();
    within(section).getByRole("button", { name: "배포 탭으로" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(selected()).toBe("배포"));
    // The keyboard goes on to the tab it opened.
    const releaseTab = screen.getByRole("tab", { name: "배포" });
    expect(document.activeElement === releaseTab).toBe(true);
  });

  test("개요는 값이 있는 버전 카드 두 장만 보이고, 최근 세션은 API가 없다고 한다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const glance = await screen.findByRole("list", { name: "에이전트 현황" });
    const figures = within(glance)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(figures[0]).toContain("배포된 버전");
    expect(figures[0]).toContain("없음");
    expect(figures[1]).toContain("version 1");
    expect(figures).toHaveLength(2);
    const recent = screen
      .getByRole("heading", { name: "최근 세션" })
      .closest("section") as HTMLElement;
    expect(
      within(recent).getByText(
        "이 에이전트의 세션을 고르는 API가 아직 없습니다.",
      ),
    ).toBeDefined();
    expect(
      within(recent)
        .getByRole("link", { name: "모든 세션" })
        .getAttribute("href"),
    ).toBe("/sessions");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  test("일시정지된 에이전트는 최신 release가 켜져 있어도 켜짐이라 하지 않는다", async () => {
    const server = agentServer();
    const path = `/v1/agents/${AGENT_ID}`;
    const post = (route: string, body: unknown) =>
      (server.routes as Record<string, (request: Request) => unknown>)[
        `POST ${path}/${route}`
      ]?.(
        new Request(`http://test${path}/${route}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    const version = server.detail().versions[0];
    await post("releases", {
      version_id: version?.id,
      runtime_profile_id: "claude-coding-local",
    });
    const release = server.detail().releases[0];
    await post("activate", { release_id: release?.id, expected_revision: -1 });
    const released = server.detail();
    expect(released.agent.active_release_id).toBe(release?.id ?? "");
    renderAt(DETAIL, {
      ...meOk,
      ...server.routes,
      [`GET ${path}`]: () =>
        json(200, {
          ...released,
          agent: { ...released.agent, status: "paused" },
        }),
    });
    const section = (
      await screen.findByRole("heading", { name: "켜기까지" })
    ).closest("section") as HTMLElement;
    expect(await within(section).findByText("할 일 있음")).toBeDefined();
    expect(within(section).queryByText("켜짐")).toBeNull();
    expect(
      within(section).getByText(
        "에이전트가 일시정지 상태라 새 세션이 이 에이전트를 쓰지 않습니다.",
      ),
    ).toBeDefined();
    expect(
      within(section).queryByRole("button", { name: "배포 탭으로" }),
    ).toBeNull();
    const user = await setupUser();
    await user.click(screen.getByRole("tab", { name: "카드" }));
    const summary = (
      await screen.findByRole("heading", { name: "에이전트 카드" })
    ).closest("section") as HTMLElement;
    expect(
      within(summary).getByText(/일시정지 상태라 새 세션은 쓰지 않습니다/),
    ).toBeDefined();
    expect(within(summary).queryByText(/새 세션에 쓰이는/)).toBeNull();
  });

  test("version이 없는 에이전트도 카드 탭에 이름과 식별자를 보인다", async () => {
    const server = agentServer();
    const path = `/v1/agents/${AGENT_ID}`;
    renderAt(`${DETAIL}?tab=card`, {
      ...meOk,
      ...server.routes,
      [`GET ${path}`]: () => json(200, { ...server.detail(), versions: [] }),
    });
    const summary = (
      await screen.findByRole("heading", { name: "에이전트 카드" })
    ).closest("section") as HTMLElement;
    await waitFor(() =>
      expect(
        within(summary).getByText("식별자", { selector: "dt" })
          .nextElementSibling?.textContent,
      ).toBe("billing"),
    );
    expect(within(summary).queryByText("역할", { selector: "dt" })).toBeNull();
  });

  test("머리의 새 세션 버튼은 꺼져 있고 이유를 읽어 준다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes });
    const button = (await screen.findByRole("button", {
      name: "이 에이전트로 새 세션",
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("웹에서는 아직 세션을 시작할 수 없습니다");
  });

  test("카드 탭은 카드를 읽기 전용으로 보이고 원문 JSON을 함께 둔다", async () => {
    renderAt(`${DETAIL}?tab=card`, { ...meOk, ...agentServer().routes });
    const summary = (
      await screen.findByRole("heading", { name: "에이전트 카드" })
    ).closest("section") as HTMLElement;
    const value = (term: string) =>
      within(summary).getByText(term, { selector: "dt" }).nextElementSibling
        ?.textContent;
    await waitFor(() => expect(value("역할")).toBe("결제 문의 담당"));
    expect(value("식별자")).toBe("billing");
    expect(value("모델")).toBe("claude-sonnet-5");
    expect(value("쓸 수 있는 도구")).toBe("프로필이 허용하는 도구 전부");
    expect(within(summary).queryByRole("textbox")).toBeNull();
    const raw = (
      screen
        .getByRole("heading", { name: "카드 원문" })
        .closest("section") as HTMLElement
    ).querySelector("pre");
    expect(JSON.parse(raw?.textContent ?? "").role).toBe("결제 문의 담당");
  });

  test("관리하지 않는 구성원에게 관리자 탭은 이유만 보이고 편집 행동이 없다", async () => {
    renderAt(`${DETAIL}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    const panel = await screen.findByRole("tabpanel");
    await within(panel).findByText(/에이전트 관리자 지정/);
    expect(within(panel).queryByRole("button")).toBeNull();
    expect(within(panel).queryByRole("combobox")).toBeNull();
  });

  test("영어 화면도 탭 이름을 옮긴다", async () => {
    renderAt(DETAIL, { ...meOk, ...agentServer().routes }, "en");
    const list = await screen.findByRole("tablist", { name: "Agent details" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "Card", "Release", "Admins"]);
  });
});

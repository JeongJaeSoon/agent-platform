import { describe, expect, test } from "bun:test";
import {
  type AgentAdminsView,
  agentAdminsViewSchema,
  type MemberView,
  TEAM_LIST_LIMIT,
  type TeamDetail,
  teamDetailSchema,
} from "@werft-ai/contracts";
import { queryKeys } from "@werft-ai/core";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { ADMINISTERED_LIST_LIMIT } from "../components/agent-admins.tsx";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  memberPage,
  RECEIPT_ID,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { act, renderAt, screen, waitFor, within } = await appHarness();

const TEAM_ID = "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
const MATE_ID = "2c7e1d4a-5b6f-4a8e-9d0c-1e2f3a4b5c6d";
const AT = "2026-10-11T00:00:00.000Z";

const mate: MemberView = {
  user_id: MATE_ID,
  email: "mate@example.com",
  display_name: "Mate",
  role: "member",
  disabled_at: null,
  created_at: AT,
};
const owner: MemberView = {
  ...mate,
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
};

/** The teams API as one stateful server, as the real routes answer. */
function teamServer() {
  let team: TeamDetail | null = {
    id: TEAM_ID,
    workspace_id: WORKSPACE_ID,
    name: "결제팀",
    member_count: 0,
    created_by: USER_ID,
    created_at: AT,
    revision: 1,
    members: [],
  };
  const view = () => {
    if (!team) throw new Error("deleted");
    const { members: _members, ...rest } = team;
    return { ...rest, member_count: team.members.length };
  };
  const change = () => json(200, { team: view(), receipt_id: RECEIPT_ID });
  const path = `/v1/teams/${TEAM_ID}`;
  return {
    get team() {
      return team;
    },
    routes: {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, memberPage({ items: [owner, mate], next_cursor: null })),
      "GET /v1/teams": () => json(200, { items: team ? [view()] : [] }),
      "POST /v1/teams": async (request: Request) => {
        const { name } = (await request.json()) as { name: string };
        if (name === team?.name)
          return apiError(409, "ALREADY_EXISTS", "A team by that name exists");
        return json(201, { team: { ...view(), name }, receipt_id: RECEIPT_ID });
      },
      [`GET ${path}`]: () =>
        team
          ? json(200, team)
          : apiError(404, "NOT_FOUND", "Resource not found"),
      [`PATCH ${path}`]: async (request: Request) => {
        const { name } = (await request.json()) as { name: string };
        if (team) team = { ...team, name, revision: team.revision + 1 };
        return change();
      },
      [`DELETE ${path}`]: () => {
        team = null;
        return json(200, { receipt_id: RECEIPT_ID });
      },
      [`POST ${path}/members`]: async (request: Request) => {
        const { user_id } = (await request.json()) as { user_id: string };
        if (team)
          team = {
            ...team,
            members: [
              ...team.members,
              {
                user_id,
                email: "mate@example.com",
                display_name: "Mate",
                added_by: USER_ID,
                added_at: AT,
              },
            ],
          };
        return change();
      },
      [`DELETE ${path}/members/${MATE_ID}`]: () => {
        if (team)
          team = {
            ...team,
            members: team.members.filter((m) => m.user_id !== MATE_ID),
          };
        return change();
      },
    },
  };
}

describe("팀 화면", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(teamDetailSchema.safeParse(teamServer().team).success).toBe(true);
  });

  test("팀은 구성원 메뉴 아래에 있어 구성원 메뉴가 모두에게 보이고 팀 메뉴는 따로 없다", async () => {
    for (const who of [me(), memberMe()]) {
      const shown = renderAt("/", { "GET /v1/auth/me": () => json(200, who) });
      const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
      expect(within(nav).getByRole("link", { name: "구성원" })).toBeDefined();
      expect(within(nav).queryByRole("link", { name: "팀" })).toBeNull();
      shown.container.remove();
    }
  });

  test("사이드바에서 빠져도 팀 주소는 그대로 열린다", async () => {
    const server = teamServer();
    renderAt("/teams", server.routes);
    expect(await screen.findByRole("link", { name: "결제팀" })).toBeDefined();
  });

  test("헤더의 팀 만들기가 대화상자를 열어 만든다. 같은 이름은 대화상자 안에서 말한다", async () => {
    const server = teamServer();
    const { api } = renderAt("/members/teams", server.routes);
    const link = await screen.findByRole("link", { name: "결제팀" });
    expect(link.getAttribute("href")).toBe(`/members/teams/${TEAM_ID}`);
    // The row opens as a whole through the name link: its box covers the
    // row, the row takes the hover fill, and the chevron sits at the row's end.
    const row = link.closest("li") as HTMLElement;
    const rowClasses = row.className.split(" ");
    expect(rowClasses).toContain("relative");
    expect(rowClasses).toContain("cursor-pointer");
    expect(rowClasses).toContain("hover:bg-hover");
    const linkClasses = link.className.split(" ");
    expect(linkClasses).toContain("after:absolute");
    expect(linkClasses).toContain("after:inset-0");
    expect(linkClasses).toContain("focus-visible:after:outline-2");
    // One ring, the row's: the link's own is off over styles.css's rule.
    expect(linkClasses).toContain("focus-visible:outline-none!");
    expect(row.querySelectorAll("a").length).toBe(1);
    const chevron = row.lastElementChild as Element;
    expect(chevron.tagName.toLowerCase()).toBe("svg");
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
    expect(link.querySelector("svg")).toBeNull();
    // The tab no longer carries a form of its own.
    expect(screen.queryByLabelText("팀 이름")).toBeNull();
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await waitFor(() =>
      expect(
        document.activeElement === within(dialog).getByLabelText("팀 이름"),
      ).toBe(true),
    );
    await user.keyboard("지원팀{Enter}");
    expect((await screen.findByRole("status")).textContent).toBe(
      "지원팀 팀을 만들었습니다.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "지원팀",
    });
    await waitFor(() => expect(document.activeElement === open).toBe(true));

    await user.click(open);
    const again = await screen.findByRole("dialog", { name: "팀 만들기" });
    // Each opening starts empty.
    expect(
      (within(again).getByLabelText("팀 이름") as HTMLInputElement).value,
    ).toBe("");
    await user.keyboard("결제팀{Enter}");
    expect((await within(again).findByRole("alert")).textContent).toBe(
      "같은 이름의 팀이 이미 있습니다 — 다른 이름을 쓰세요.",
    );
    // Refused, the dialog stays with the name to fix, and the earlier
    // notice is gone: it was about another team.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      (within(again).getByLabelText("팀 이름") as HTMLInputElement).value,
    ).toBe("결제팀");
    // Behind the modal dialog the page is aria-hidden.
    expect(screen.getByRole("status", { hidden: true }).textContent).toBe("");
  });

  test("팀 목록을 못 불러오면 헤더에 팀 만들기 대신 목록 자리에 다시 시도를 보인다", async () => {
    const server = teamServer();
    renderAt("/members/teams", {
      ...server.routes,
      "GET /v1/teams": () => apiError(500, "INTERNAL", "boom"),
    });
    expect(
      await screen.findByRole("button", { name: "다시 시도" }),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
  });

  test("끝에 / 가 붙은 팀 목록 주소에서도 헤더에 팀 만들기가 있다", async () => {
    const server = teamServer();
    renderAt("/members/teams/", server.routes);
    await screen.findByRole("link", { name: "결제팀" });
    expect(
      await screen.findByRole("button", { name: "팀 만들기" }),
    ).toBeDefined();
  });

  test("만드는 중에 다른 탭으로 갔다 돌아오면 늦게 온 성공 알림을 새 방문에 띄우지 않는다", async () => {
    const server = teamServer();
    let answer: ((response: Response) => void) | undefined;
    const { api, history } = renderAt("/members/teams", {
      ...server.routes,
      "POST /v1/teams": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await screen.findByRole("link", { name: "결제팀" });
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await user.type(within(dialog).getByLabelText("팀 이름"), "지원팀{Enter}");
    await within(dialog).findByRole("button", { name: "만드는 중…" });
    act(() => history.push("/members"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "팀 만들기" })).toBeNull(),
    );
    act(() => history.back());
    await screen.findByRole("link", { name: "결제팀" });
    answer?.(
      json(201, {
        team: {
          ...server.team,
          members: undefined,
          name: "지원팀",
          member_count: 0,
        },
        receipt_id: RECEIPT_ID,
      }),
    );
    // The success handler ends by refreshing the list: once that request
    // goes out, the handler has run.
    const lists = api.calls.filter(
      (c) => c.method === "GET" && c.path === "/v1/teams",
    ).length;
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === "GET" && c.path === "/v1/teams")
          .length,
      ).toBeGreaterThan(lists),
    );
    expect(screen.getByRole("status").textContent).toBe("");
  });

  test("팀 상세에는 헤더 주 버튼이 없다", async () => {
    const server = teamServer();
    renderAt(`/members/teams/${TEAM_ID}`, server.routes);
    await screen.findByRole("heading", { level: 2, name: "결제팀" });
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "구성원 초대" })).toBeNull();
  });

  test("Esc로 닫으면 포커스가 헤더의 팀 만들기로 돌아오고 아무것도 보내지 않는다", async () => {
    const server = teamServer();
    const { api } = renderAt("/members/teams", server.routes);
    await screen.findByRole("link", { name: "결제팀" });
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    open.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await waitFor(() =>
      expect(
        document.activeElement === within(dialog).getByLabelText("팀 이름"),
      ).toBe(true),
    );
    await user.keyboard("지원팀{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement === open).toBe(true);
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("만드는 중에는 저장 버튼이 aria-disabled로 포커스를 지키고 다시 보내지 않는다", async () => {
    const server = teamServer();
    let answer: ((response: Response) => void) | undefined;
    const { api } = renderAt("/members/teams", {
      ...server.routes,
      "POST /v1/teams": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    await screen.findByRole("link", { name: "결제팀" });
    const user = await setupUser();
    const open = await waitFor(() => {
      const button = screen.getByRole("button", { name: "팀 만들기" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(open);
    const dialog = await screen.findByRole("dialog", { name: "팀 만들기" });
    await user.type(within(dialog).getByLabelText("팀 이름"), "지원팀");
    const save = within(dialog).getByRole("button", { name: "팀 만들기" });
    save.focus();
    await user.keyboard("{Enter}");
    const busy = await within(dialog).findByRole("button", {
      name: "만드는 중…",
    });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement === busy).toBe(true);
    await user.keyboard("{Enter}");
    // Neither Escape nor 취소 drops a request on its way.
    await user.keyboard("{Escape}");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "팀 만들기" })).not.toBeNull();
    answer?.(
      json(201, {
        team: {
          ...server.team,
          members: undefined,
          name: "지원팀",
          member_count: 0,
        },
        receipt_id: RECEIPT_ID,
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "지원팀 팀을 만들었습니다.",
    );
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("구성원에게는 만들기 폼·전체 목록·권한 없음 화면이 없고 서버에 묻지 않는다", async () => {
    const { api } = renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": () =>
        apiError(403, "FORBIDDEN", "This principal does not hold team.manage"),
      "GET /v1/my-teams": () => json(200, { items: [] }),
    });
    expect(await screen.findByText("아직 속한 팀이 없습니다.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "팀 만들기" })).toBeNull();
    expect(screen.queryByLabelText("팀 이름")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("team.manage");
    expect(api.calls.some((c) => c.path === "/v1/teams")).toBe(false);
  });

  test("구성원은 자기가 속한 팀을 본다", async () => {
    const refused = () =>
      apiError(403, "FORBIDDEN", "This principal does not hold team.manage");
    const joined = renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": refused,
      "GET /v1/my-teams": () =>
        json(200, { items: [{ id: TEAM_ID, name: "결제팀" }] }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    expect(within(section).getByText("결제팀")).toBeDefined();
    expect(within(section).queryByRole("link")).toBeNull();
    joined.container.remove();

    renderAt("/members/teams", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/teams": refused,
      "GET /v1/my-teams": () => json(200, { items: [] }),
    });
    expect(await screen.findByText("아직 속한 팀이 없습니다.")).toBeDefined();
  });

  test("팀 상세를 볼 수 없는 사람에게도 화면 제목이 있다", async () => {
    renderAt(`/members/teams/${TEAM_ID}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET /v1/teams/${TEAM_ID}`]: () =>
        apiError(403, "FORBIDDEN", "This principal does not hold team.manage"),
    });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "이 화면을 볼 권한이 없습니다",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "구성원" }),
    ).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "팀" })).toBeDefined();
    expect(screen.getByRole("link", { name: "팀 목록" })).toBeDefined();
  });

  test("팀을 관리하는 사람의 팀 화면에는 전체 목록만 있다", async () => {
    const server = teamServer();
    const { api } = renderAt("/members/teams", server.routes);
    await screen.findByRole("link", { name: "결제팀" });
    expect(screen.queryByRole("heading", { name: "내가 속한 팀" })).toBeNull();
    expect(api.calls.some((c) => c.path === "/v1/my-teams")).toBe(false);
  });

  test("예전 팀 주소는 구성원의 팀 탭으로 옮겨 간다", async () => {
    const server = teamServer();
    const list = renderAt("/teams", server.routes);
    await screen.findByRole("link", { name: "결제팀" });
    expect(list.history.location.pathname).toBe("/members/teams");
    const tab = screen.getByRole("link", { name: "팀", current: "page" });
    expect(tab.getAttribute("href")).toBe("/members/teams");
    list.container.remove();

    const detail = renderAt(`/teams/${TEAM_ID}`, server.routes);
    expect(
      await screen.findByRole("heading", { level: 2, name: "결제팀" }),
    ).toBeDefined();
    expect(detail.history.location.pathname).toBe(`/members/teams/${TEAM_ID}`);
    // The team opens inside the 팀 tab, which stays the current one.
    expect(
      screen.getByRole("link", { name: "팀", current: "page" }),
    ).toBeDefined();
  });

  test("키보드로 고르기 칸에 오면 그때 구성원을 읽어 고를 수 있다", async () => {
    const { api } = renderAt(`/members/teams/${TEAM_ID}`, teamServer().routes);
    const picker = await screen.findByLabelText("추가할 사람");
    const memberReads = () =>
      api.calls.filter((c) => c.path === "/v1/members").map((c) => c.search);
    expect(memberReads()).toEqual(["?limit=2"]);
    act(() => picker.focus());
    expect(
      await screen.findByRole("option", { name: "Mate (mate@example.com)" }),
    ).toBeTruthy();
    expect(memberReads()).toEqual(["?limit=2", "?limit=100"]);
  });

  test("전에 읽은 목록에 후보가 없었어도 칸은 열려 있고, 다시 읽는 동안에도 키보드가 머문다", async () => {
    let answer: () => void = () => {};
    const asked = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const server = teamServer();
    const { services } = renderAt("/members/teams", {
      ...server.routes,
      "GET /v1/members?limit=100": async () => {
        await asked;
        return json(200, { items: [owner, mate], next_cursor: null });
      },
    });
    await screen.findByRole("link", { name: "결제팀" });
    // An earlier visit read a list with nobody to add; Mate joined since.
    services.queryClient.setQueryData(queryKeys.members, {
      items: [],
      next_cursor: null,
    });
    const user = await setupUser();
    await user.click(screen.getByRole("link", { name: "결제팀" }));
    const picker = (await screen.findByLabelText(
      "추가할 사람",
    )) as HTMLSelectElement;
    expect(picker.disabled).toBe(false);
    act(() => picker.focus());
    await waitFor(() => expect(picker.getAttribute("aria-busy")).toBe("true"));
    expect(picker.disabled).toBe(false);
    expect(document.activeElement === picker).toBe(true);
    act(() => answer());
    expect(
      await screen.findByRole("option", { name: "Mate (mate@example.com)" }),
    ).toBeTruthy();
    expect(document.activeElement === picker).toBe(true);
  });

  test("구성원을 수락 없이 넣고 빼며, 이름을 바꾸고 지운다", async () => {
    const server = teamServer();
    const { api, history } = renderAt(
      `/members/teams/${TEAM_ID}`,
      server.routes,
    );
    const user = await setupUser();
    // Every member is read only once the pointer reaches the picker; the
    // page head asks for the first two alone.
    const picker = await screen.findByLabelText("추가할 사람");
    expect(
      api.calls.filter((c) => c.path === "/v1/members").map((c) => c.search),
    ).toEqual(["?limit=2"]);
    await user.hover(picker);
    await screen.findByRole("option", { name: "Mate (mate@example.com)" });
    await user.selectOptions(screen.getByLabelText("추가할 사람"), MATE_ID);
    await user.click(screen.getByRole("button", { name: "구성원 추가" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Mate님을 팀에 추가했습니다.",
    );
    expect(
      api.calls.find((c) => c.method === "POST" && c.path.endsWith("/members"))
        ?.body,
    ).toEqual({
      user_id: MATE_ID,
    });
    // The owner is the only one left to add; Mate is in the team now.
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("추가할 사람"))
          .getAllByRole("option")
          .map((o) => o.getAttribute("value")),
      ).toEqual(["", USER_ID]),
    );

    const removeMate = await screen.findByRole("button", {
      name: "Mate님을 팀에서 빼기",
    });
    // Cancelling sends nothing; Mate stays.
    await user.click(removeMate);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "취소",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);

    await user.click(removeMate);
    const removeDialog = await screen.findByRole("dialog");
    expect(removeDialog.textContent).toContain(
      "Mate님을 결제팀 팀에서 뺄까요?",
    );
    await user.click(
      within(removeDialog).getByRole("button", { name: "빼기" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Mate님을 팀에서 뺐습니다.",
      ),
    );

    const name = screen.getByLabelText("팀 이름");
    await user.clear(name);
    await user.type(name, "청구팀");
    await user.click(screen.getByRole("button", { name: "이름 바꾸기" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "팀 이름을 청구팀(으)로 바꿨습니다.",
      ),
    );

    // Deleting sits last on the page, in its own danger zone, behind a confirm.
    const danger = screen.getByRole("region", { name: "위험 구역" });
    expect(screen.getAllByRole("region").at(-1) === danger).toBe(true);
    const teamPath = `/v1/teams/${TEAM_ID}`;
    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "취소",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      api.calls.some((c) => c.method === "DELETE" && c.path === teamPath),
    ).toBe(false);

    await user.click(within(danger).getByRole("button", { name: "팀 삭제" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "팀 삭제" }));
    await waitFor(() =>
      expect(history.location.pathname).toBe("/members/teams"),
    );
    expect(server.team).toBeNull();
    expect(await screen.findByText("아직 팀이 없습니다.")).toBeDefined();
  });
});

const admins = (over: Partial<AgentAdminsView> = {}): AgentAdminsView => ({
  users: [
    {
      user_id: MATE_ID,
      email: "mate@example.com",
      display_name: "Mate",
      created_by: USER_ID,
      created_at: AT,
    },
  ],
  teams: [],
  ...over,
});

describe("에이전트 관리자", () => {
  test("픽스처는 서버가 보낼 수 있는 모양이다", () => {
    expect(agentAdminsViewSchema.safeParse(admins()).success).toBe(true);
  });

  test("사람 고르기 칸에 키보드로 오면 그때 구성원을 읽는다", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      ...teamServer().routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    const picker = await screen.findByLabelText("관리자로 추가할 사람");
    const memberReads = () =>
      api.calls.filter((c) => c.path === "/v1/members").length;
    expect(memberReads()).toBe(0);
    act(() => picker.focus());
    await waitFor(() => expect(memberReads()).toBe(1));
    await waitFor(() =>
      expect(within(picker).getAllByRole("option").length).toBeGreaterThan(1),
    );
  });

  test("owner는 사람·팀을 지정하고 해제한다", async () => {
    const agentsApi = agentServer();
    const teams = teamServer();
    let current = admins();
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      ...teams.routes,
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, current),
      [`POST /v1/agents/${AGENT_ID}/admins`]: async (request: Request) => {
        const body = (await request.json()) as { team_id?: string };
        current = admins({
          teams: [
            {
              team_id: body.team_id ?? "",
              name: "결제팀",
              created_by: USER_ID,
              created_at: AT,
            },
          ],
        });
        return json(200, { admins: current, receipt_id: RECEIPT_ID });
      },
      [`DELETE /v1/agents/${AGENT_ID}/admins/users/${MATE_ID}`]: () => {
        current = { ...current, users: [] };
        return json(200, { admins: current, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    await screen.findByRole("option", { name: "결제팀" });
    await user.selectOptions(
      screen.getByLabelText("관리자로 추가할 팀"),
      TEAM_ID,
    );
    await user.click(screen.getByRole("button", { name: "팀 추가" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "결제팀을(를) 관리자로 추가했습니다.",
    );
    expect(
      api.calls.find((c) => c.method === "POST" && c.path.endsWith("/admins"))
        ?.body,
    ).toEqual({ team_id: TEAM_ID });

    await user.click(
      screen.getByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("다시 관리자로 추가하면 돌아옵니다");
    expect(dialog.textContent).not.toContain("나 자신을 빼면");
    await user.click(within(dialog).getByRole("button", { name: "빼기" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Mate을(를) 관리자에서 뺐습니다.",
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeNull();
  });

  test("에이전트 관리자인 구성원이 자기 자신을 빼면 관리 권한을 잃는다고 경고하고, 취소하면 보내지 않는다", async () => {
    const agentsApi = agentServer();
    const agent = agentsApi.detail().agent;
    const self = {
      user_id: USER_ID,
      email: "owner@example.com",
      display_name: "Owner",
      created_by: USER_ID,
      created_at: AT,
    };
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(200, admins({ users: [self] })),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner을(를) 관리자에서 빼기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("나 자신을 빼면 관리 권한을 잃습니다");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("모든 에이전트를 관리하는 소유자가 자기 자신을 빼도 권한을 잃는다고 하지 않는다", async () => {
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        json(200, {
          users: [
            {
              user_id: USER_ID,
              email: "owner@example.com",
              display_name: "Owner",
              created_by: USER_ID,
              created_at: AT,
            },
          ],
          teams: [],
        }),
    });
    const user = await setupUser();
    await user.click(
      await screen.findByRole("button", {
        name: "Owner을(를) 관리자에서 빼기",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain("나 자신을 빼면");
  });

  test("관리 목록이 상한까지 차 있으면 이 에이전트의 관리자 목록에 직접 묻는다", async () => {
    expect(ADMINISTERED_LIST_LIMIT).toBe(TEAM_LIST_LIMIT);
    const agentsApi = agentServer();
    const agent = (
      (await (
        await agentsApi.routes[`GET /v1/agents/${AGENT_ID}`]()
      ).json()) as { agent: { id: string } }
    ).agent;
    const others = Array.from({ length: TEAM_LIST_LIMIT }, () => ({
      ...agent,
      id: crypto.randomUUID(),
    }));
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: others }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    expect(
      await screen.findByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeDefined();
  });

  test("관리 여부를 묻지 못하면 권한 문구가 아니라 실패를 보인다", async () => {
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () =>
        apiError(500, "INTERNAL", "Internal error"),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "처리하지 못했습니다 — 잠시 뒤 다시 시도하세요.",
    );
    expect(
      within(alert).getByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "에이전트 관리자 지정 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.",
      ),
    ).toBeNull();
  });

  test("관리자 목록이 실패하면 권한 문구가 아니라 실패를 보인다", async () => {
    renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () =>
        apiError(503, "BACKEND_UNAVAILABLE", "Backend unavailable"),
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "서버가 응답하지 않습니다 — 잠시 뒤 다시 시도하세요.",
    );
    expect(
      within(alert).getByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
  });

  test("관리하지 않는 구성원은 이유만 보고, 관리자 목록을 묻지 않는다", async () => {
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    expect(
      await screen.findByText(
        "에이전트 관리자 지정 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.",
      ),
    ).toBeDefined();
    expect(api.calls.some((c) => c.path.endsWith("/admins"))).toBe(false);
  });

  test("자기 에이전트의 관리자인 구성원은 목록을 보고, 고르기는 이유와 함께 닫혀 있다", async () => {
    const agentsApi = agentServer();
    const agent = (
      (await (
        await agentsApi.routes[`GET /v1/agents/${AGENT_ID}`]()
      ).json()) as { agent: unknown }
    ).agent;
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=admins`, {
      ...agentsApi.routes,
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
      [`GET /v1/agents/${AGENT_ID}/admins`]: () => json(200, admins()),
    });
    expect(
      await screen.findByRole("button", { name: "Mate을(를) 관리자에서 빼기" }),
    ).toBeDefined();
    const person = screen.getByRole("button", { name: "사람 추가" });
    expect(person.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(person.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("구성원 관리 권한이 있어야 할 수 있습니다. 지금 역할: 구성원.");
    // Neither list is asked for, so no refused decision is left behind.
    expect(
      api.calls.some((c) => c.path === "/v1/members" || c.path === "/v1/teams"),
    ).toBe(false);
  });
});

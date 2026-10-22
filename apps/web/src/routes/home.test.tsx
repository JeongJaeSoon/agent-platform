import { describe, expect, test } from "bun:test";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const owner = {
  user_id: USER_ID,
  email: "owner@example.com",
  display_name: "Owner",
  role: "owner",
  disabled_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
};

const noSessions = {
  "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
};

const oneSession = {
  id: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
  revision: 1,
  admission_state: "active",
  status: "idle",
  runtime: {
    kind: "claude_agent_sdk",
    version: "1.0.0",
    profile_id: "default",
    model: "model-default",
    permission_mode: "default",
  },
  repository_id: "demo",
  current_turn_id: null,
  queued_turn_count: 0,
  last_event_at: null,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:00.000Z",
};

async function states() {
  await screen.findByRole("heading", { name: "Acme" });
  // Home has other lists; the checklist is the region named for it.
  return () =>
    within(screen.getByRole("region", { name: "시작하기" }))
      .getAllByRole("listitem")
      .map((step) => step.getAttribute("data-state"));
}

describe("bootstrap checklist", () => {
  test("처음에는 소유자만 완료이고, 초대·에이전트·세션 단계는 각 화면으로 잇는다", async () => {
    const server = agentServer();
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/sessions")).toBe(true),
    );
    await waitFor(() =>
      expect(read()).toEqual(["done", "pending", "pending", "pending"]),
    );
    expect(
      screen
        .getByRole("link", { name: "첫 세션 확인하기" })
        .getAttribute("href"),
    ).toBe("/sessions");
    expect(
      screen
        .getByRole("link", { name: "구성원 초대하기" })
        .getAttribute("href"),
    ).toBe("/members");
    expect(
      screen
        .getByRole("link", { name: "에이전트 준비하기" })
        .getAttribute("href"),
    ).toBe("/agents");
  });

  test("초대를 보냈고 활성 release가 있는 에이전트가 있으면 두 단계가 완료다", async () => {
    const server = agentServer();
    const agent = { ...server.detail().agent, active_release_id: "rel-1" };
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () =>
        json(200, {
          items: [
            {
              id: "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a",
              workspace_id: me().workspace?.id,
              email: "late@example.com",
              role: "member",
              invited_by: USER_ID,
              status: "pending",
              expires_at: "2026-10-18T00:00:00.000Z",
              accepted_at: null,
              revoked_at: null,
              created_at: "2026-10-11T00:00:00.000Z",
            },
          ],
        }),
      "GET /v1/agents": () => json(200, { items: [agent] }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "done", "done", "pending"]),
    );
    expect(agent.id).toBe(AGENT_ID);
  });

  test("만들기만 하고 활성화하지 않은 에이전트는 아직이다", async () => {
    const server = agentServer();
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () =>
        json(200, { items: [owner, { ...owner, user_id: AGENT_ID }] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "done", "pending", "pending"]),
    );
  });

  test("구성원은 혼자인데 초대 조회가 실패하면 초대 단계는 모른다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => apiError(500, "INTERNAL", "boom"),
      "GET /v1/agents": () => json(200, { items: [] }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "unknown", "pending", "pending"]),
    );
  });

  test("관리 권한이 없으면 모르는 단계는 모른다고 적는다", async () => {
    const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "unknown", "unknown", "pending"]),
    );
    expect(screen.getAllByText("확인할 수 없음")).toHaveLength(2);
  });

  test("내 세션이 하나라도 있으면 세션 단계는 완료다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": () => apiError(403, "FORBIDDEN", "not allowed"),
      "GET /v1/invites": () => apiError(403, "FORBIDDEN", "not allowed"),
      "GET /v1/agents": () => apiError(403, "FORBIDDEN", "not allowed"),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions": () =>
        json(200, { items: [oneSession], next_cursor: null }),
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "unknown", "unknown", "done"]),
    );
  });

  test("세션 목록을 읽지 못하면 세션 단계는 모른다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [] }),
      "GET /v1/sessions": () => apiError(500, "INTERNAL", "boom"),
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "pending", "pending", "unknown"]),
    );
  });
});

describe("홈 요약", () => {
  const waitingSession = {
    ...oneSession,
    id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    status: "needs_input",
  };
  const homeRoutes = () => {
    const server = agentServer();
    const released = {
      ...server.detail().agent,
      active_release_id: "rel-1",
    };
    return {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () =>
        json(200, { items: [released, server.detail().agent] }),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [waitingSession], next_cursor: null }),
      "GET /v1/sessions": () =>
        json(200, {
          items: [waitingSession, oneSession],
          next_cursor: "next",
        }),
    };
  };

  test("답이 필요한 세션을 먼저, 이어서 세 요약 카드와 최근 세션을 보인다", async () => {
    renderAt("/", homeRoutes());
    const waiting = await screen.findByRole("region", {
      name: /답이 필요한 요청/,
    });
    await waitFor(() =>
      expect(
        within(waiting).getByRole("link", { name: waitingSession.id }),
      ).toBeDefined(),
    );
    expect(
      within(waiting)
        .getByRole("link", { name: "전체 보기" })
        .getAttribute("href"),
    ).toBe("/sessions");

    const overview = screen.getByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(
        within(overview)
          .getAllByRole("listitem")
          .map((card) => [
            card.querySelector("h3")?.textContent,
            card.querySelector("h3 + div > p")?.textContent,
          ]),
      ).toEqual([
        ["답변 대기", "1"],
        ["세션", "2+"],
        ["에이전트", "2"],
      ]),
    );
    expect(within(overview).getByText("켜짐 1 · 초안 1")).toBeDefined();

    const recent = screen.getByRole("table", { name: "최근 세션" });
    expect(
      within(recent)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([waitingSession.id, oneSession.id]);
  });

  test("시작하기를 다 마치면 checklist는 요약 아래로 내려간다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/members": () =>
        json(200, {
          items: [
            owner,
            {
              ...owner,
              user_id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
              email: "member@example.com",
              role: "member",
            },
          ],
        }),
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "done", "done", "done"]),
    );
    const order = [...document.querySelectorAll("main section > div h2")].map(
      (heading) => heading.textContent,
    );
    expect(order.indexOf("시작하기")).toBeGreaterThan(
      order.findIndex((title) => title?.startsWith("최근 세션")),
    );
  });
});

describe("내가 속한 팀", () => {
  const TEAM = { id: "9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b", name: "결제팀" };
  const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");

  test("구성원은 홈에서 속한 팀 이름을 본다. 팀 화면은 열 수 없으니 링크가 아니다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/my-teams": () => json(200, { items: [TEAM] }),
    });
    const section = await screen.findByRole("region", {
      name: "내가 속한 팀",
    });
    expect(within(section).getByText("결제팀")).toBeDefined();
    expect(within(section).queryByRole("link")).toBeNull();
  });

  test("팀을 관리하는 사람에게는 팀 화면 링크다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": () => json(200, { items: [] }),
      "GET /v1/my-teams": () => json(200, { items: [TEAM] }),
    });
    const link = await screen.findByRole("link", { name: "결제팀" });
    expect(link.getAttribute("href")).toBe(`/teams/${TEAM.id}`);
  });

  test("속한 팀이 없으면 홈에 섹션을 두지 않는다", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/my-teams": () => json(200, { items: [] }),
    });
    await screen.findByRole("heading", { name: "Acme" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/my-teams")).toBe(true),
    );
    // Let the empty answer render before checking that nothing did.
    await Bun.sleep(50);
    expect(screen.queryByRole("heading", { name: "내가 속한 팀" })).toBeNull();
  });
});

describe("내가 관리하는 에이전트", () => {
  const forbidden = () => apiError(403, "FORBIDDEN", "not allowed");
  const memberRoutes = {
    "GET /v1/auth/me": () => json(200, memberMe()),
    "GET /v1/members": forbidden,
    "GET /v1/invites": forbidden,
    "GET /v1/agents": forbidden,
  };

  test("관리자로 지정된 에이전트를 상세 링크로 보인다", async () => {
    const agent = agentServer().detail().agent;
    renderAt("/", {
      ...memberRoutes,
      "GET /v1/administered-agents": () => json(200, { items: [agent] }),
    });
    await screen.findByRole("heading", { name: "내가 관리하는 에이전트" });
    expect(
      screen.getByRole("link", { name: agent.name }).getAttribute("href"),
    ).toBe(`/agents/${AGENT_ID}`);
  });

  test("관리하는 에이전트가 없으면 섹션을 보이지 않는다", async () => {
    const { api } = renderAt("/", {
      ...memberRoutes,
      "GET /v1/administered-agents": () => json(200, { items: [] }),
    });
    await screen.findByRole("heading", { name: "Acme" });
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/v1/administered-agents")).toBe(
        true,
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "내가 관리하는 에이전트" }),
    ).toBeNull();
  });

  test("모든 에이전트를 관리하는 소유자에게는 묻지도 보이지도 않는다", async () => {
    const server = agentServer();
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/members": () => json(200, { items: [owner] }),
      "GET /v1/invites": () => json(200, { items: [] }),
      "GET /v1/agents": server.routes["GET /v1/agents"],
      ...noSessions,
    });
    const read = await states();
    await waitFor(() =>
      expect(read()).toEqual(["done", "pending", "pending", "pending"]),
    );
    expect(api.calls.some((c) => c.path === "/v1/administered-agents")).toBe(
      false,
    );
    expect(
      screen.queryByRole("heading", { name: "내가 관리하는 에이전트" }),
    ).toBeNull();
  });
});

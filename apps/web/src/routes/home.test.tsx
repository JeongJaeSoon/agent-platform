import { describe, expect, jest, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import { queryKeys, waitingSessionsQuery } from "@werft-ai/core";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  USER_ID,
  WORKSPACE_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";
import { statusPageQuery, useNow, waitedFor } from "./home.tsx";

const { act, renderAt, renderHook, screen, waitFor, within } =
  await appHarness();

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
  await screen.findByRole("heading", { name: "홈" });
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
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000 + 60_000).toISOString();
  const limits = {
    scope: "installation",
    refreshed_at: "2026-10-23T09:00:00.000Z",
    limits: {
      execution_slot_limit: 8,
      queued_input_limit_per_session: 20,
      storage_limit_bytes: 1073741824,
      max_turn_seconds: 3600,
      session_cost_limit_usd: "20",
      session_token_limit: null,
      provider_max_retries: 2,
    },
    usage: {
      execution_slots_used: 3,
      queued_input_count: 0,
      storage: {
        used_bytes: 0,
        accounted_content: ["input_messages"],
        updated_at: null,
      },
    },
  };
  const expiringKey = {
    id: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    kind: "service",
    workspace_id: WORKSPACE_ID,
    agent_id: AGENT_ID,
    created_by: USER_ID,
    scopes: ["sessions:read"],
    created_at: "2026-10-01T00:00:00.000Z",
    expires_at: inDays(3),
    revoked_at: null,
  };
  /** Each card as title, headline and its label/value rows. */
  const cards = (overview: HTMLElement) =>
    within(overview)
      .getAllByRole("listitem")
      .filter((item) => item.querySelector("h3"))
      .map((card) => ({
        title: card.querySelector("h3")?.textContent,
        badge:
          card.querySelector("h3")?.parentElement?.nextElementSibling
            ?.textContent,
        value: card.querySelector("p.text-number")?.textContent,
        rows: [...card.querySelectorAll("dl > div")].map((row) => [
          row.querySelector("dt")?.textContent,
          row.querySelector("dd")?.textContent,
        ]),
      }));
  const waitingSession = {
    ...oneSession,
    id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    title: "hello.txt 만들고 commit",
    status: "needs_input",
  };
  const request = (created_at: string) => ({
    kind: "permission",
    request_id: `req-${created_at}`,
    turn_id: "turn-1",
    attempt_id: "attempt-1",
    created_at,
    expires_at: "2026-10-23T09:30:00.000Z",
    tool: "Bash",
    input: { command: "ls" },
  });
  const pending = (id: string, created_at: string) => ({
    [`GET /v1/sessions/${id}/pending-requests`]: () =>
      json(200, { answerable: true, items: [request(created_at)] }),
  });
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
      "GET /v1/limits": () => json(200, limits),
      "GET /v1/api-keys": () => json(200, { items: [expiringKey] }),
      ...pending(waitingSession.id, "2026-10-23T09:00:00.000Z"),
    };
  };

  test("카드 세 장에 실제 수치와 미계측을 나눠 보이고, 답변 대기는 가장 오래된 요청 하나만 가리킨다", async () => {
    renderAt("/", homeRoutes());
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)).toEqual([
        {
          title: "전체 사용량",
          badge: undefined,
          value: "—미계측",
          rows: [
            ["세션", "—미계측"],
            ["동시 실행", "3 / 8 slot"],
            ["결과물 저장", "—미계측"],
          ],
        },
        {
          title: "확인할 항목",
          badge: "운영",
          value: "2",
          rows: [
            ["답변 대기", "1"],
            ["30분 넘게 대기", "1개 세션"],
            ["가장 오래된 요청", expect.stringContaining("1a2b3c4d · ")],
            ["결제 담당", "3일 후 만료"],
            ["에이전트", "켜짐 1 · 초안 1"],
          ],
        },
        {
          title: "내가 시작한 세션 기준",
          badge: undefined,
          value: "—미계측",
          rows: [
            ["세션", "—미계측"],
            ["실행 시간", "—미계측"],
            ["토큰", "—미계측"],
          ],
        },
      ]),
    );
    // The waiting request is answerable from home, above the cards.
    const inbox = screen.getByRole("region", { name: /^답변 대기/ });
    expect(
      inbox.compareDocumentPosition(overview) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const oldest = await within(overview).findByRole("link", {
      name: waitingSession.id.slice(0, 8),
    });
    expect(oldest.getAttribute("href")).toBe(`/sessions/${waitingSession.id}`);
    expect(
      within(overview)
        .getByRole("link", { name: "결제 담당" })
        .getAttribute("href"),
    ).toBe("/settings/api-keys/service");

    expect(
      screen.getByText("설치 전체 수치는 설치 운영자에게만 보입니다"),
    ).toBeTruthy();
    const recent = screen.getByRole("table", { name: "최근 세션" });
    // The design's dot, not a pill: amber for waiting, the text says which.
    expect(
      [...recent.querySelectorAll("[data-dot]")].map((dot) =>
        dot.getAttribute("data-dot"),
      ),
    ).toEqual(["wait", "idle"]);
    expect(
      [...recent.querySelectorAll("tr")].map((row) =>
        [...row.children].map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["세션", "작업 상태", "에이전트", "저장소", "최근 활동"],
      [
        `${waitingSession.title}${waitingSession.id.slice(0, 8)}`,
        expect.stringMatching(/^작업: 답변 대기 · \d+(분|시간|일)$/),
        "—",
        "demo",
        expect.any(String),
      ],
      [
        oneSession.id.slice(0, 8),
        "작업: 쉬는 중",
        "—",
        "demo",
        expect.any(String),
      ],
    ]);
    expect(
      within(recent)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual([`/sessions/${waitingSession.id}`, `/sessions/${oneSession.id}`]);
    // A titled session links by its title; one without a title, by its id.
    expect(
      within(recent)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual([waitingSession.title, oneSession.id.slice(0, 8)]);
  });

  test("한도를 읽을 수 없는 사람에게는 설치 전체 카드를 숨긴다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/limits": () => apiError(403, "FORBIDDEN", "forbidden"),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview).map((card) => card.title)).toEqual([
        "확인할 항목",
        "내가 시작한 세션 기준",
      ]),
    );
  });

  test("막 들어온 요청과 만료가 먼 key는 확인할 항목이 아니다", async () => {
    const recentRequest = new Date(Date.now() - 60_000).toISOString();
    renderAt("/", {
      ...homeRoutes(),
      ...pending(waitingSession.id, recentRequest),
      "GET /v1/api-keys": () =>
        json(200, {
          items: [
            { ...expiringKey, expires_at: inDays(30) },
            {
              ...expiringKey,
              id: "8b7a6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e",
              revoked_at: inDays(-1),
            },
          ],
        }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() => {
      const check = cards(overview)[1];
      expect(check?.value).toBe("0");
      expect(check?.rows.map(([label]) => label)).toEqual([
        "답변 대기",
        "30분 넘게 대기",
        "가장 오래된 요청",
        "에이전트",
      ]);
      expect(check?.rows[1]).toEqual(["30분 넘게 대기", "0개 세션"]);
    });
  });

  test("가장 오래된 요청은 세션의 갱신 시각이 아니라 요청 시각으로 고른다", async () => {
    // Updated first, asked last: updated_at would pick it.
    const askedLate = {
      ...waitingSession,
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      updated_at: "2026-10-23T08:00:00.000Z",
    };
    const askedEarly = {
      ...waitingSession,
      updated_at: "2026-10-23T08:30:00.000Z",
    };
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [askedLate, askedEarly], next_cursor: null }),
      ...pending(askedLate.id, "2026-10-23T09:10:00.000Z"),
      ...pending(askedEarly.id, "2026-10-23T09:00:00.000Z"),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    const oldest = await within(overview).findByRole("link", {
      name: askedEarly.id.slice(0, 8),
    });
    expect(oldest.getAttribute("href")).toBe(`/sessions/${askedEarly.id}`);
    expect(
      oldest.parentElement?.querySelector("time")?.getAttribute("title"),
    ).toBe("2026. 10. 23. 18:00");
  });

  test("대기 세션 목록을 다시 읽다 실패하면 전에 고른 가장 오래된 요청을 내린다", async () => {
    let fail = false;
    const { services } = renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        fail
          ? json(500, { error: { code: "INTERNAL" } })
          : json(200, { items: [waitingSession], next_cursor: null }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    const name = waitingSession.id.slice(0, 8);
    await within(overview).findByRole("link", { name });
    fail = true;
    await act(async () => {
      await services.queryClient.refetchQueries({
        queryKey: queryKeys.waitingSessions,
      });
      // The query batches its notification on a timer; let it land in act.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() =>
      expect(within(overview).queryByRole("link", { name })).toBeNull(),
    );
  });

  test("대기 세션이 한 페이지를 넘으면 가장 오래된 요청도, 오래 기다린 수도 짐작하지 않는다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [waitingSession], next_cursor: "more" }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)[1]?.rows[0]).toEqual(["답변 대기", "1+"]),
    );
    // The keys answered; the waiting count is what stays unknown.
    await waitFor(() =>
      expect(
        within(overview).getByRole("link", { name: "결제 담당" }),
      ).toBeDefined(),
    );
    expect(cards(overview)[1]?.value).toBe("—");
    expect(cards(overview)[1]?.rows[1]).toEqual(["30분 넘게 대기", "—"]);
    expect(
      within(overview).queryByRole("link", {
        name: waitingSession.id.slice(0, 8),
      }),
    ).toBeNull();
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

  test.each([
    ["owner", [], "설치 전체 현황과 워크스페이스 점검 항목입니다."],
    ["admin", [], "내 세션과 관리하는 에이전트, 워크스페이스 점검 항목입니다."],
    [
      "member",
      [agentServer().detail().agent],
      "Owner 님이 관리하는 에이전트와 내 세션을 기준으로 구성했습니다.",
    ],
    [
      "member",
      [],
      "Owner 님이 시작했거나 공유받은 세션을 기준으로 구성했습니다.",
    ],
  ] as const)(
    "설명은 역할로 고른다: %s, 관리하는 에이전트 %p",
    async (role, administered, intro) => {
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/auth/me": () => json(200, me(undefined, role)),
        "GET /v1/administered-agents": () => json(200, { items: administered }),
      });
      expect(await screen.findByText(intro)).toBeDefined();
    },
  );

  test("다시 읽기에 실패한 목록은 진행 상황 합계에 옛 값으로 남지 않는다", async () => {
    const running = {
      ...oneSession,
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      status: "running",
    };
    let runningFails = false;
    const { services } = renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions?status=running": () =>
        runningFails
          ? json(500, { error: { code: "INTERNAL", message: "boom" } })
          : json(200, { items: [running], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    const progress = () => cards(overview)[1];
    await waitFor(() =>
      expect(progress()).toMatchObject({
        value: "2",
        rows: [
          ["답변 대기", "1"],
          ["작업 중", "1"],
          ["쉬는 중", "0"],
        ],
      }),
    );
    runningFails = true;
    await act(() => services.queryClient.refetchQueries());
    await waitFor(() =>
      expect(progress()).toMatchObject({
        value: "—",
        rows: [
          ["답변 대기", "1"],
          ["작업 중", "—"],
          ["쉬는 중", "0"],
        ],
      }),
    );
  });

  test("비활성으로 알려 온 Slack 계정은 연결로 세지 않고 다시 연결을 보인다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions?status=running": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [], next_cursor: null }),
      "GET /v1/linked-accounts": () =>
        json(200, {
          items: [
            {
              id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b",
              user_id: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c",
              provider: "slack",
              external_tenant: "T0001",
              external_user_id: "U0001",
              status: "stale",
              verified_at: "2026-10-01T00:00:00Z",
              revision: 1,
            },
          ],
        }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview)[2]).toMatchObject({
        value: "0 / 3",
        rows: [
          ["GitHub", "준비 중"],
          ["Slack", "다시 연결"],
          ["Google Workspace", "준비 중"],
        ],
      }),
    );
  });

  test("관리하는 에이전트를 읽지 못하면 카드를 짐작하지 않고 다시 시도를 보인다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () =>
        json(500, { error: { code: "INTERNAL", message: "boom" } }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    expect(
      await within(overview).findByRole("button", { name: "다시 시도" }),
    ).toBeTruthy();
    expect(within(overview).queryAllByRole("listitem")).toEqual([]);
  });

  test("구성원 홈은 내 사용량, 진행 상황, 연동 계정 카드다", async () => {
    const running = {
      ...oneSession,
      id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      status: "running",
    };
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/administered-agents": () => json(200, { items: [] }),
      "GET /v1/sessions?status=running": () =>
        json(200, { items: [running], next_cursor: null }),
      "GET /v1/sessions?status=idle": () =>
        json(200, { items: [oneSession], next_cursor: "next" }),
      "GET /v1/linked-accounts": () => json(200, { items: [] }),
    });
    const overview = await screen.findByRole("region", { name: "한눈에 보기" });
    await waitFor(() =>
      expect(cards(overview).slice(1)).toEqual([
        {
          title: "진행 상황",
          badge: "지금",
          value: "3+",
          rows: [
            ["답변 대기", "1"],
            ["작업 중", "1"],
            ["쉬는 중", "1+"],
          ],
        },
        {
          title: "연결 상태",
          badge: "내 계정",
          value: "0 / 3",
          rows: [
            ["GitHub", "준비 중"],
            ["Slack", "연결 안 됨"],
            ["Google Workspace", "준비 중"],
          ],
        },
      ]),
    );
    expect(cards(overview)[0]?.title).toBe("내가 시작한 세션 기준");
    expect(
      [...overview.querySelectorAll("[data-dot]")].map((dot) =>
        dot.getAttribute("data-dot"),
      ),
    ).toEqual(["wait", "run", "idle", "idle", "idle", "idle"]);
    // The "last 30 days" basis waits for a usage period; only the owner's shows.
    expect(
      screen.queryByText("설치 전체 수치는 설치 운영자에게만 보입니다"),
    ).toBeNull();
    expect(
      within(overview)
        .getByRole("link", { name: /연동 계정 보기/ })
        .getAttribute("href"),
    ).toBe("/settings/linked-accounts");
  });

  test.each([
    ["member", ["내가 시작한 세션 기준", "AGENT", "AGENT"]],
    ["admin", ["내가 시작한 세션 기준", "AGENT", "확인할 항목"]],
  ] as const)(
    "%s가 관리하는 에이전트는 카드로 보인다",
    async (role, titles) => {
      const agent = agentServer().detail().agent;
      const other = {
        ...agent,
        id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
        name: "Second",
      };
      renderAt("/", {
        ...homeRoutes(),
        "GET /v1/auth/me": () => json(200, me(undefined, role)),
        "GET /v1/administered-agents": () =>
          json(200, {
            items: [
              agent,
              other,
              { ...other, id: "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a" },
            ],
          }),
      });
      const overview = await screen.findByRole("region", {
        name: "한눈에 보기",
      });
      const expected = titles.map((title, index) =>
        title === "AGENT" ? [agent.name, other.name][index - 1] : title,
      );
      await waitFor(() =>
        expect(cards(overview).map((card) => card.title)).toEqual(expected),
      );
      expect(
        within(overview)
          .getAllByRole("link", { name: /에이전트 보기/ })[0]
          ?.getAttribute("href"),
      ).toBe(`/agents/${agent.id}`);
    },
  );

  test("새 세션 버튼은 세션 목록처럼 사유와 함께 막혀 있다", async () => {
    renderAt("/", {
      ...homeRoutes(),
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    const button = await screen.findByRole("button", { name: "새 세션" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요.");
  });
});

describe("statusPageQuery", () => {
  test("작업 중·쉬는 중 목록은 답변 대기 목록과 같은 주기로 다시 읽는다", () => {
    // The open total adds the three lists; read at different paces it would
    // count a session that moved between them twice or not at all.
    const client = {} as ApiClient;
    for (const status of ["running", "idle"] as const)
      expect<unknown>(
        statusPageQuery(client, status, true).refetchInterval,
      ).toBe(waitingSessionsQuery(client).refetchInterval);
  });
});

describe("waitedFor", () => {
  const at = "2026-10-23T09:00:00.000Z";
  const after = (ms: number) => new Date(at).getTime() + ms;
  test("가장 큰 단위의 정수로 적는다", () => {
    expect(waitedFor(at, "ko", after(12 * 60_000 + 59_000))).toBe("12분");
    expect(waitedFor(at, "ko", after(2 * 3_600_000 + 5 * 60_000))).toBe(
      "2시간",
    );
    expect(waitedFor(at, "en", after(30_000))).toBe("0 min");
  });
  test("시계가 어긋나 미래 시각이어도 음수로 적지 않는다", () => {
    expect(waitedFor(at, "ko", after(-60_000))).toBe("0분");
  });
  test("홈의 시각은 응답이 그대로여도 분마다 움직인다", () => {
    jest.useFakeTimers({ now: new Date(at) });
    try {
      const { result, unmount } = renderHook(() => useNow());
      expect(waitedFor(at, "ko", result.current)).toBe("0분");
      act(() => jest.advanceTimersByTime(12 * 60_000));
      expect(waitedFor(at, "ko", result.current)).toBe("12분");
      unmount();
    } finally {
      jest.useRealTimers();
    }
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
    expect(link.getAttribute("href")).toBe(`/members/teams/${TEAM.id}`);
  });

  test("속한 팀이 없으면 홈에 섹션을 두지 않는다", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/members": forbidden,
      "GET /v1/invites": forbidden,
      "GET /v1/agents": forbidden,
      "GET /v1/my-teams": () => json(200, { items: [] }),
    });
    await screen.findByRole("heading", { name: "홈" });
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
    await screen.findByRole("heading", { name: "홈" });
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

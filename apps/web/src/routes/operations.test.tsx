import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

const NOW = new Date("2026-10-24T12:40:00.000Z");

const COUNTS = {
  counts: {
    queued: 2,
    running: 7,
    needs_input: 3,
    idle: 41,
    failed: 1,
    stopped: 12,
  },
  total: 66,
};

const LIMITS = {
  scope: "installation",
  refreshed_at: "2026-10-24T12:40:00.000Z",
  limits: {
    execution_slot_limit: 10,
    queued_input_limit_per_session: 20,
    storage_limit_bytes: 10737418240,
    max_turn_seconds: 3600,
    session_cost_limit_usd: "25.00",
    session_token_limit: null,
    provider_max_retries: 3,
  },
  usage: {
    execution_slots_used: 7,
    queued_input_count: 4,
    storage: {
      used_bytes: 2147483648,
      accounted_content: ["input_messages"],
      updated_at: "2026-10-24T12:31:00.000Z",
    },
  },
};

// Over 30 days the installation adds up to 435 sessions, 64h 15m, $1,045.50
// and 38.16M tokens; "me" to 17 sessions.
function series(scope: "me" | "installation", days: number) {
  return {
    period: {
      since: new Date(Date.UTC(2026, 9, 25 - days)).toISOString(),
      until: "2026-10-25T00:00:00.000Z",
    },
    refreshed_at: NOW.toISOString(),
    buckets: Array.from({ length: days }, (_, i) => ({
      date: new Date(Date.UTC(2026, 9, 25 - days + i))
        .toISOString()
        .slice(0, 10),
      session_count: scope === "me" ? (i < 17 ? 1 : 0) : i,
      cost_usd: "34.85",
      cost_complete: true,
      token_count: 1_272_000,
      run_seconds: 7710,
    })),
  };
}

const TOOLS = {
  tools: [
    {
      name: "Bash",
      calls: 1840,
      failed: 21,
      total_ms: 13320000,
      median_ms: 3100,
      max_ms: 298000,
    },
    {
      name: "Read",
      calls: 1204,
      failed: 2,
      total_ms: 1080000,
      median_ms: 400,
      max_ms: 9100,
    },
    {
      name: "Edit",
      calls: 702,
      failed: 12,
      total_ms: 1620000,
      median_ms: 900,
      max_ms: 14200,
    },
    {
      name: "WebFetch",
      calls: 214,
      failed: 1,
      total_ms: 3960000,
      median_ms: 12400,
      max_ms: 61000,
    },
  ],
  findings: [
    { kind: "most_time", name: "Bash" },
    { kind: "fails_often", name: "Edit" },
    { kind: "slowest", name: "WebFetch" },
  ],
};

function toolCalls(name: string) {
  return {
    calls: [
      {
        session_id: "11111111-1111-4111-8111-111111111111",
        title: `${name} 리뷰`,
        agent: "리뷰 봇",
        occurred_at: "2026-10-24T12:39:10.000Z",
        duration_ms: null,
        outcome: "unknown",
      },
      {
        session_id: null,
        title: null,
        agent: "배포 도우미",
        occurred_at: "2026-10-24T12:36:41.000Z",
        duration_ms: 41200,
        outcome: "ok",
      },
      {
        session_id: "22222222-2222-4222-8222-222222222222",
        title: "에이전트 없는 세션",
        agent: null,
        occurred_at: "2026-10-24T12:31:15.000Z",
        duration_ms: 3400,
        outcome: "failed",
      },
    ],
    next_cursor: null,
    per_day: Array.from({ length: 30 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10),
      calls: i + 1,
    })),
  };
}

// The fake API answers by path, and nothing for /v1/usage/summary; the call
// log says which period was asked.
const usageRoutes = {
  "GET /v1/sessions/counts": () => json(200, COUNTS),
  "GET /v1/usage/tools": () => json(200, TOOLS),
  ...Object.fromEntries(
    TOOLS.tools.map(({ name }) => [
      `GET /v1/usage/tools/${name}/calls`,
      () => json(200, toolCalls(name)),
    ]),
  ),
  "GET /v1/usage/series": (request: Request) => {
    const query = new URL(request.url).searchParams;
    const days = Math.round(
      (Date.parse(query.get("until") ?? "") -
        Date.parse(query.get("since") ?? "")) /
        86_400_000,
    );
    return json(200, series(query.get("scope") as "me" | "installation", days));
  },
};

describe("운영", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("owner: 사이드바 '운영'에서 개요를 열고, '지금' 숫자는 /v1/sessions/counts 그대로다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    const nav = await screen.findByRole("navigation", { name: "주요 메뉴" });
    expect(
      within(nav)
        .getByRole("link", { name: "운영" })
        .getAttribute("aria-current"),
    ).toBe("page");
    const counts = await screen.findByRole("link", {
      name: /^실행 중|작업 중/,
    });
    expect(counts.textContent).toBe("작업 중7");
    const cells = screen
      .getAllByRole("link")
      .filter(
        (a) =>
          a.getAttribute("href")?.startsWith("/sessions") &&
          /\d$/.test(a.textContent ?? ""),
      )
      .map((a) => [a.textContent, a.getAttribute("href")]);
    expect(cells).toEqual([
      ["대기 중2", "/sessions"],
      ["작업 중7", "/sessions?status=running"],
      ["답변 대기3", "/sessions?status=needs_input"],
      ["쉬는 중41", "/sessions?status=idle"],
      ["실패1", "/sessions?status=failed"],
      ["멈춤12", "/sessions?status=stopped"],
    ]);
    expect(await screen.findByText("동시 실행 slot · 설치 전체")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "운영 탭" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["개요", "도구 활동", "한도"]);
    expect(screen.getByRole("group", { name: "집계 범위" })).toBeTruthy();
    const asked = api.calls.find((call) => call.path === "/v1/usage/series");
    expect(asked?.search).toBe(
      "?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z",
    );
  });

  test("KPI 4개는 summary를 부르지 않고 같은 series 버킷의 합이다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    expect(await screen.findByText("435")).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const value of ["64시간 15분", "$1,045.50", "3,816만"]) {
      expect(text).toContain(value);
    }
    expect(
      api.calls
        .filter((call) => call.path.startsWith("/v1/usage/"))
        .map((call) => call.path)
        .sort(),
    ).toEqual(["/v1/usage/series", "/v1/usage/tools"]);
  });

  test("개요의 '살펴볼 것'은 /v1/usage/tools의 findings이고 도구 활동 탭으로 이어진다", async () => {
    setSystemTime(NOW);
    renderAt("/operations?days=7", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
      ...usageRoutes,
    });
    const section = (
      await screen.findByRole("heading", { name: "살펴볼 것" })
    ).closest("section");
    if (!section) throw new Error("no 살펴볼 것 section");
    await waitFor(() =>
      expect(
        within(section)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "가장 오래 걸리는 도구: Bash3시간 42분 · 전체 도구 시간의 67%",
        "자주 실패하는 도구: Edit702번 중 12번 실패 (1.7%)",
        "가장 느린 도구: WebFetch보통 12.4초 · 호출 214번",
      ]),
    );
    expect(
      within(section)
        .getByRole("link", { name: "도구 활동" })
        .getAttribute("href"),
    ).toBe("/operations/tools?days=7");
  });

  for (const [role, who] of [
    ["admin", () => me(undefined, "admin")],
    ["member", memberMe],
  ] as const) {
    test(`${role}: 한도 탭·설치 전체 범위·slot 줄이 없고 /v1/limits를 읽지 않는다`, async () => {
      setSystemTime(NOW);
      const { api } = renderAt("/operations", {
        "GET /v1/auth/me": () => json(200, who()),
        ...usageRoutes,
      });
      expect(await screen.findByText("17")).toBeTruthy();
      const tabs = screen.getByRole("navigation", { name: "운영 탭" });
      expect(
        within(tabs)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ).toEqual(["개요", "도구 활동"]);
      expect(screen.queryByRole("group", { name: "집계 범위" })).toBeNull();
      expect(screen.queryByText("동시 실행 slot · 설치 전체")).toBeNull();
      expect(api.calls.some((call) => call.path === "/v1/limits")).toBe(false);
      expect(
        api.calls
          .filter((call) => call.path.startsWith("/v1/usage/"))
          .every((call) => call.search.startsWith("?scope=me&")),
      ).toBe(true);
    });
  }

  test("기간을 바꾸면 URL이 바뀌고 그 기간을 한 번씩 읽는다", async () => {
    setSystemTime(NOW);
    const { api, history } = renderAt("/operations", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    expect(
      await screen.findByRole("heading", { name: "최근 30일" }),
    ).toBeTruthy();
    const user = await setupUser();
    await user.click(screen.getByRole("button", { name: "7일" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "최근 7일" })).toBeTruthy(),
    );
    expect(history.location.search).toBe("?days=7");
    await waitFor(() =>
      expect(
        api.calls
          .filter(
            (call) =>
              call.path.startsWith("/v1/usage/") &&
              call.search.includes("since=2026-10-18"),
          )
          .map((call) => call.path)
          .sort(),
      ).toEqual(["/v1/usage/series", "/v1/usage/tools"]),
    );
  });

  test("도구 활동 탭: 표와 레일, 볼 수 없는 세션은 링크가 없고 결과 모름·시간 없음·에이전트 없음을 그대로 쓴다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations/tools", {
      "GET /v1/auth/me": () => json(200, me()),
      ...usageRoutes,
    });
    const table = await screen.findByRole("table", { name: "도구와 명령" });
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => row.textContent),
      ).toEqual([
        "Bash1,8403시간 42분3.1초21",
        "Read1,20418분0.4초2",
        "Edit70227분0.9초12",
        "WebFetch2141시간 6분12.4초1",
      ]),
    );
    const tabs = screen.getByRole("navigation", { name: "운영 탭" });
    expect(
      within(tabs)
        .getByRole("link", { name: "도구 활동" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.querySelector("[data-slot=page-flush]")).not.toBeNull();
    const rail = screen.getByRole("complementary", { name: "선택한 도구" });
    expect(within(rail).getByRole("heading", { name: "Bash" })).toBeTruthy();
    const items = await within(rail).findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Bash 리뷰리뷰 봇 · 12:39—결과 모름",
      "볼 수 없는 세션배포 도우미 · 12:3641.2초완료",
      "에이전트 없는 세션12:313.4초실패",
    ]);
    expect(
      within(rail)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/sessions/11111111-1111-4111-8111-111111111111",
      "/sessions/22222222-2222-4222-8222-222222222222",
    ]);
    expect(
      within(rail)
        .getByRole("img", { name: /^Bash 일자별 호출/ })
        .getAttribute("aria-label"),
    ).toBe("Bash 일자별 호출, 최근 14일, 합계 329번, 가장 많은 날 10/24 30번");
    expect(
      api.calls
        .filter((call) => call.path.startsWith("/v1/usage/tools"))
        .map((call) => `${call.path}${call.search}`),
    ).toEqual([
      "/v1/usage/tools?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z",
      "/v1/usage/tools/Bash/calls?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z&sort=recent&limit=7",
    ]);
  });

  test("도구 활동 탭: 다른 도구를 고르면 그 도구의 호출을 한 번 읽고, 정렬·검색은 다시 읽지 않는다", async () => {
    setSystemTime(NOW);
    const { api } = renderAt("/operations/tools", {
      "GET /v1/auth/me": () => json(200, me()),
      ...usageRoutes,
    });
    const table = await screen.findByRole("table", { name: "도구와 명령" });
    const user = await setupUser();
    await user.click(
      await within(table).findByRole("button", { name: "Edit 자세히 보기" }),
    );
    const rail = screen.getByRole("complementary", { name: "선택한 도구" });
    await waitFor(() =>
      expect(within(rail).getByText("Edit 리뷰")).toBeTruthy(),
    );
    const callsOf = (name: string) =>
      api.calls.filter((call) => call.path === `/v1/usage/tools/${name}/calls`);
    expect(callsOf("Edit")).toHaveLength(1);

    const before = api.calls.length;
    await user.click(
      within(screen.getByRole("group", { name: "정렬" })).getByRole("button", {
        name: "느린 순",
      }),
    );
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("row")
          .slice(1)
          .map((row) => row.querySelector(".font-mono")?.textContent),
      ).toEqual(["WebFetch", "Bash", "Edit", "Read"]),
    );
    await user.type(screen.getByRole("searchbox", { name: "도구 찾기" }), "ed");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    await waitFor(() =>
      expect(
        screen
          .getByRole("table", { name: "도구와 명령" })
          .querySelectorAll("[role=row]"),
      ).toHaveLength(2),
    );
    expect(api.calls.length).toBe(before);
  });

  test("도구 활동 탭: agent_id search param은 두 API에 그대로 간다", async () => {
    setSystemTime(NOW);
    const agent = "33333333-3333-4333-8333-333333333333";
    const { api } = renderAt(`/operations/tools?agent_id=${agent}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...usageRoutes,
    });
    await screen.findByRole("complementary", { name: "선택한 도구" });
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.path.startsWith("/v1/usage/tools")),
      ).toHaveLength(2),
    );
    for (const call of api.calls.filter((c) =>
      c.path.startsWith("/v1/usage/tools"),
    )) {
      expect(new URLSearchParams(call.search).get("agent_id")).toBe(agent);
      expect(new URLSearchParams(call.search).get("scope")).toBe("me");
    }
  });

  test("한도 탭: owner는 한도 표를 본다", async () => {
    setSystemTime(NOW);
    renderAt("/operations/limits", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/limits": () => json(200, LIMITS),
    });
    const table = await screen.findByRole("table", { name: "한도" });
    expect(await within(table).findByText("설정 안 됨")).toBeTruthy();
    expect(within(table).getByText("7 / 10")).toBeTruthy();
  });

  test("한도 탭을 member가 열면 권한 없음이고 /v1/limits를 읽지 않는다", async () => {
    const { api } = renderAt("/operations/limits", {
      "GET /v1/auth/me": () => json(200, memberMe()),
    });
    expect(
      await screen.findByText("이 화면을 볼 권한이 없습니다"),
    ).toBeTruthy();
    expect(screen.queryByRole("table", { name: "한도" })).toBeNull();
    expect(api.calls.some((call) => call.path === "/v1/limits")).toBe(false);
  });
});

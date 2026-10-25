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

function summary(scope: "me" | "installation", days: number) {
  return {
    scope,
    period: {
      since: new Date(Date.UTC(2026, 9, 25 - days)).toISOString(),
      until: "2026-10-25T00:00:00.000Z",
    },
    refreshed_at: NOW.toISOString(),
    session_count: scope === "me" ? 17 : 400,
    cost_usd: "1045.48",
    cost_complete: true,
    token_count: 38_160_000,
    run_seconds: 64 * 3600 + 3 * 60,
    basis: {
      sessions: "created_in_period",
      cost: "provider_usage_estimate",
      run_time: "turn_wall_clock",
    },
  };
}

function series(days: number) {
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
      session_count: i,
      cost_usd: "1.00",
      cost_complete: true,
      token_count: 100,
      run_seconds: 60,
    })),
  };
}

// The fake API answers by path; the call log says which period was asked.
const usageRoutes = {
  "GET /v1/sessions/counts": () => json(200, COUNTS),
  "GET /v1/usage/summary": (request: Request) => {
    const query = new URL(request.url).searchParams;
    const days = Math.round(
      (Date.parse(query.get("until") ?? "") -
        Date.parse(query.get("since") ?? "")) /
        86_400_000,
    );
    return json(
      200,
      summary(query.get("scope") as "me" | "installation", days),
    );
  },
  "GET /v1/usage/series": (request: Request) => {
    const query = new URL(request.url).searchParams;
    const days = Math.round(
      (Date.parse(query.get("until") ?? "") -
        Date.parse(query.get("since") ?? "")) /
        86_400_000,
    );
    return json(200, series(days));
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
    ).toEqual(["개요", "한도"]);
    expect(screen.getByRole("group", { name: "집계 범위" })).toBeTruthy();
    expect(await screen.findByText("400")).toBeTruthy();
    const asked = api.calls.find((call) => call.path === "/v1/usage/summary");
    expect(asked?.search).toBe(
      "?scope=installation&since=2026-09-25T00%3A00%3A00.000Z&until=2026-10-25T00%3A00%3A00.000Z",
    );
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
      ).toEqual(["개요"]);
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
        api.calls.filter(
          (call) =>
            call.path === "/v1/usage/series" &&
            call.search.includes("since=2026-10-18"),
        ),
      ).toHaveLength(1),
    );
    expect(
      api.calls.filter(
        (call) =>
          call.path === "/v1/usage/summary" &&
          call.search.includes("since=2026-10-18"),
      ),
    ).toHaveLength(1);
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

import { describe, expect, test } from "bun:test";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

function summary(scope: "me" | "installation", sessions: number) {
  return {
    scope,
    period: {
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-22T10:30:00.000Z",
    },
    refreshed_at: "2026-10-22T10:30:00.000Z",
    session_count: sessions,
    cost_usd: scope === "me" ? "4.20" : "182.40",
    cost_complete: scope === "installation",
    token_count: 1_234_567,
    run_seconds: 3 * 3600 + 20 * 60,
    basis: {
      sessions: "created_in_period",
      cost: "provider_usage_estimate",
      run_time: "turn_wall_clock",
    },
  };
}

const LIMITS = {
  scope: "installation",
  refreshed_at: "2026-10-22T10:30:00.000Z",
  limits: {
    execution_slot_limit: 8,
    queued_input_limit_per_session: 20,
    storage_limit_bytes: 1024 * 1024 * 1024,
    max_turn_seconds: 3600,
    session_cost_limit_usd: "5.00",
    session_token_limit: null,
    provider_max_retries: 2,
  },
  usage: {
    execution_slots_used: 3,
    queued_input_count: 4,
    storage: {
      used_bytes: 512 * 1024 * 1024,
      accounted_content: ["input_messages"],
      updated_at: "2026-10-22T10:00:00.000Z",
    },
  },
};

const summaryRoute = (scope: "me" | "installation") =>
  `GET /v1/usage/summary?scope=${scope}&since=${new Date().toISOString().slice(0, 8)}01`;

describe("사용량·한도", () => {
  test("구성원은 내 사용량만 보고, 설치 한도는 읽지 않는다", async () => {
    const { api } = renderAt("/usage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [summaryRoute("me")]: () => json(200, summary("me", 12)),
    });
    expect(
      await screen.findByText(
        "내가 시작한 세션 기준 · 2026-10-01 00:00 ~ 10-22 10:30 (UTC)",
      ),
    ).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3시간 20분")).toBeTruthy();
    expect(screen.getByText("$4.20")).toBeTruthy();
    expect(screen.getByText("1,234,567")).toBeTruthy();
    // An unfinished turn makes the total a floor, never a settled figure.
    expect(
      screen.getByText(
        "진행 중이거나 비용을 보고하지 않은 turn이 있어 실제보다 적을 수 있음",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "집계 범위" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "한도" })).toBeNull();
    expect(api.calls.some((call) => call.path === "/v1/limits")).toBe(false);
  });

  test("설치 운영자는 설치 전체로 바꾸고 설치 한도를 본다", async () => {
    const { api } = renderAt("/usage", {
      "GET /v1/auth/me": () => json(200, me()),
      [summaryRoute("me")]: () => json(200, summary("me", 12)),
      [summaryRoute("installation")]: () =>
        json(200, summary("installation", 1284)),
      "GET /v1/limits": () => json(200, LIMITS),
    });
    const group = await screen.findByRole("group", { name: "집계 범위" });
    const user = await setupUser();
    await user.click(within(group).getByRole("button", { name: "설치 전체" }));
    expect(await screen.findByText("1,284")).toBeTruthy();
    expect(screen.getByText("provider 청구액과 다를 수 있음")).toBeTruthy();
    expect(
      api.calls.some((call) => call.search.includes("scope=installation")),
    ).toBe(true);

    const table = screen.getByRole("table");
    const row = (name: string) =>
      within(table).getByText(name).closest("tr") as HTMLElement;
    expect(within(row("동시 실행 slot")).getByText("3 / 8")).toBeTruthy();
    expect(within(row("입력 메시지 저장")).getByText("512MB")).toBeTruthy();
    expect(within(row("입력 메시지 저장")).getByText("1GB")).toBeTruthy();
    expect(within(row("세션당 비용")).getByText("$5.00")).toBeTruthy();
    expect(within(row("세션당 토큰")).getByText("설정 안 됨")).toBeTruthy();
    expect(within(row("세션당 대기 입력")).getByText("20건")).toBeTruthy();
    expect(within(row("turn 최대 시간")).getByText("1시간 0분")).toBeTruthy();
  });

  test("이 기간에 세션이 없으면 0을 늘어놓지 않고 빈 상태를 보인다", async () => {
    renderAt("/usage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [summaryRoute("me")]: () => json(200, summary("me", 0)),
    });
    expect(await screen.findByText("아직 사용 기록이 없습니다")).toBeTruthy();
    expect(screen.queryByText("3시간 20분")).toBeNull();
  });

  test("1분이 안 되는 실행 시간은 0분이 아니라 초로 보인다", async () => {
    renderAt("/usage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [summaryRoute("me")]: () =>
        json(200, { ...summary("me", 3), run_seconds: 2 }),
    });
    expect(await screen.findByText("2초")).toBeTruthy();
  });

  test("합계를 읽지 못하면 다시 시도로 다시 읽는다", async () => {
    let fail = true;
    renderAt("/usage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [summaryRoute("me")]: () =>
        fail ? apiError(500, "INTERNAL", "boom") : json(200, summary("me", 12)),
    });
    const retry = await screen.findByRole("button", { name: "다시 시도" });
    fail = false;
    const user = await setupUser();
    await user.click(retry);
    await waitFor(() => expect(screen.getByText("$4.20")).toBeTruthy());
  });
});

import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@werft-ai/contracts";
import { json, me } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor } = await appHarness();

const AT = "2026-10-25T01:00:00Z";

function summary(
  n: number,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    title: `세션 ${n}`,
    revision: 1,
    admission_state: "active",
    status: "running",
    runtime: null,
    repository_id: null,
    current_turn_id: "1",
    queued_turn_count: 0,
    model: "model-default",
    last_event_at: AT,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as SessionSummary;
}

describe("/sessions/map", () => {
  test("until the list comes, the loading screen stands in for the board", async () => {
    const held: ((response: Response) => void)[] = [];
    const { api } = renderAt("/sessions/map", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        new Promise<Response>((resolve) => {
          held.push(resolve);
        }),
    });
    // The route's own pending screen says the same; the screen has to be up.
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.path === "/v1/sessions" && call.search === "",
        ),
      ).toBe(true),
    );
    await screen.findByText("불러오는 중입니다");
    expect(screen.queryByRole("heading", { name: "에이전트 지도" })).toBeNull();

    for (const answer of held)
      answer(json(200, { items: [], next_cursor: null }));
    await screen.findByRole("heading", { level: 1, name: "에이전트 지도" });
  });

  test("a waiting session older than the newest page still counts on the strip, as on the badge", async () => {
    const waiting = summary(0, {
      title: "오래된 질문",
      status: "needs_input",
      created_at: "2026-10-01T00:00:00Z",
      activity: {
        last: null,
        tool_count: 1,
        error_count: 0,
        subagent_count: 0,
        current_tool: {
          id: "toolu_1",
          name: "AskUserQuestion",
          target: "",
          state: "waiting",
          since: AT,
          request: { kind: "question", prompt: "어디로 배포할까요?" },
        },
        window: { events: 1, complete: true, since: null },
      },
    });
    const newest = Array.from({ length: 50 }, (_, i) => summary(i + 1));
    renderAt("/sessions/map", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        json(200, { items: newest, next_cursor: "older" }),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [waiting], next_cursor: null }),
    });
    const strip = await screen.findByRole("region", {
      name: "내 답변을 기다리는 요청",
    });
    expect(strip.textContent).toContain("답변 대기 1");
    expect(strip.textContent).toContain("질문 · 어디로 배포할까요?");
    expect(screen.getAllByText("답변 대기 1개").length).toBeGreaterThan(0);
  });
});

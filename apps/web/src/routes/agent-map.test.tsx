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

  test("a waiting session whose request its activity does not show reads its pending requests", async () => {
    const hidden = summary(0, {
      title: "창 밖의 질문",
      status: "needs_input",
      created_at: "2026-10-01T00:00:00Z",
    });
    const newest = Array.from({ length: 50 }, (_, i) => summary(i + 1));
    renderAt("/sessions/map", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        json(200, { items: newest, next_cursor: "older" }),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: [hidden], next_cursor: null }),
      [`GET /v1/sessions/${hidden.id}/pending-requests`]: () =>
        json(200, {
          answerable: true,
          items: [
            {
              request_id: "req_1",
              turn_id: "1",
              attempt_id: "att_1",
              kind: "question",
              created_at: AT,
              expires_at: "2026-10-25T02:00:00Z",
              questions: [
                {
                  question_id: "q_1",
                  prompt: "어느 브랜치로 올릴까요?",
                  options: [],
                  multi_select: false,
                  allow_free_text: true,
                },
              ],
            },
          ],
        }),
    });
    const strip = await screen.findByRole("region", {
      name: "내 답변을 기다리는 요청",
    });
    await waitFor(() =>
      expect(strip.textContent).toContain("질문 · 어느 브랜치로 올릴까요?"),
    );
    expect(strip.textContent).toContain("답변 대기 1");
  });

  test("a session both lists name is drawn as the later read says", async () => {
    const asked = summary(1, {
      title: "막 물어본 세션",
      status: "needs_input",
      activity: {
        last: null,
        tool_count: 1,
        error_count: 0,
        subagent_count: 0,
        current_tool: {
          id: "toolu_1",
          name: "Bash",
          target: "git push",
          state: "waiting",
          since: AT,
          request: { kind: "permission", prompt: null },
        },
        window: { events: 1, complete: true, since: null },
      },
    });
    const held: ((response: Response) => void)[] = [];
    renderAt("/sessions/map", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        json(200, {
          items: [{ ...asked, status: "running", activity: undefined }],
          next_cursor: null,
        }),
      "GET /v1/sessions?status=needs_input": () =>
        new Promise<Response>((resolve) => {
          held.push(resolve);
        }),
    });
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    // The newest page is read first; the waiting list comes after it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const answer of held)
      answer(json(200, { items: [asked], next_cursor: null }));
    const strip = await screen.findByRole("region", {
      name: "내 답변을 기다리는 요청",
    });
    expect(strip.textContent).toContain("답변 대기 1");
    expect(strip.textContent).toContain("Bash · git push");
  });
});

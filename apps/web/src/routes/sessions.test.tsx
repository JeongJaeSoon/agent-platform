import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type {
  ListPendingRequestsResponse,
  SessionDetail,
  SessionSummary,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import { apiError, json, me, memberMe } from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, act } = await appHarness();

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const OTHER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const AT = "2026-10-11T08:14:02.000Z";

/** Records every stream the screen opens, and lets a test push frames. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    super();
    FakeEventSource.opened.push(this);
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  emit(id: string, event: string, data: unknown, turnId: string | null = "1") {
    const envelope = {
      schema_version: 1,
      session_id: SESSION_ID,
      turn_id: turnId,
      attempt_id: null,
      occurred_at: AT,
      data,
    };
    this.dispatchEvent(
      new MessageEvent(event, {
        data: JSON.stringify(envelope),
        lastEventId: id,
      }),
    );
  }
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const realEventSource = globalThis.EventSource;
globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
afterAll(() => {
  globalThis.EventSource = realEventSource;
});
beforeEach(() => {
  FakeEventSource.opened = [];
});

function summary(id: string, overrides: Partial<SessionSummary> = {}) {
  return {
    id,
    revision: 3,
    admission_state: "active",
    status: "running",
    runtime: { kind: "claude_code", version: "1.0.0", profile_id: "default" },
    repository_id: "demo",
    current_turn_id: "1",
    queued_turn_count: 0,
    last_event_at: AT,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  } as SessionSummary;
}

const detail = {
  ...summary(SESSION_ID, { status: "needs_input" }),
  execution: null,
  checkpoint_revision: null,
  pending_request_count: 1,
  attention: { code: "BUDGET_EXCEEDED", reason: "cost limit reached" },
  durability: {
    last_transcript_persisted_at: null,
    checkpoint_committed_at: null,
    checkpoint_revision: null,
    last_completed_turn_id: null,
    last_checkpointed_turn_id: null,
    checkpoint_pending_reason: null,
    checkpoint_fallback_revision: null,
    context_reset_turn_id: null,
  },
} as SessionDetail;

const usage: SessionUsageResponse = {
  session_id: SESSION_ID,
  period: "session_lifetime",
  refreshed_at: AT,
  cost: {
    amount_usd: "0.4200",
    kind: "estimated",
    source: "provider_usage",
    completeness_scope: "turn_reports",
    complete: false,
    reported_turn_count: 1,
    unreported_turn_count: 0,
    open_turn_count: 1,
  },
  cost_limit_usd: "5",
  token_count: 1234,
  token_limit: null,
  budget_exceeded: true,
  queued_input_count: 0,
  queued_input_limit: 10,
};

const pending: ListPendingRequestsResponse = {
  items: [
    {
      kind: "permission",
      request_id: "req_1",
      turn_id: "1",
      attempt_id: "att_1",
      created_at: AT,
      expires_at: AT,
      tool: "Bash",
      input: { command: "ls" },
    },
  ],
};

const detailRoutes = {
  "GET /v1/auth/me": () => json(200, me()),
  [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, detail),
  [`GET /v1/sessions/${SESSION_ID}/usage`]: () => json(200, usage),
  [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () => json(200, pending),
};

describe("sessions list", () => {
  test("shows the caller's sessions and pages on with the cursor", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("cursor") === "next-1"
          ? json(200, { items: [summary(OTHER_ID)], next_cursor: null })
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: "next-1",
            }),
    });

    const link = await screen.findByRole("link", { name: SESSION_ID });
    expect(link.getAttribute("href")).toBe(`/sessions/${SESSION_ID}`);
    expect(screen.getByText("쉬는 중")).toBeTruthy();
    expect(screen.getByText("default · claude_code 1.0.0")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("link", { name: OTHER_ID });
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    expect(
      api.calls.filter((call) => call.path === "/v1/sessions"),
    ).toHaveLength(2);
  });

  test("says so when there are none", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    expect(await screen.findByText("아직 세션이 없습니다.")).toBeTruthy();
  });

  test("the menu links to it", async () => {
    renderAt(
      "/",
      {
        "GET /v1/auth/me": () => json(200, memberMe()),
        "GET /v1/agents/administered": () =>
          json(200, { items: [], next_cursor: null }),
      },
      "en",
    );
    const nav = await screen.findByRole("navigation");
    const link = await waitFor(() => {
      const found = Array.from(nav.querySelectorAll("a")).find(
        (anchor) => anchor.textContent === "Sessions",
      );
      if (!found) throw new Error("no Sessions link");
      return found;
    });
    expect(link.getAttribute("href")).toBe("/sessions");
  });
});

describe("session detail", () => {
  test("shows status, cost, pending requests and streamed events", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);

    expect(await screen.findByText("답변 대기")).toBeTruthy();
    expect(screen.getByText("BUDGET_EXCEEDED")).toBeTruthy();
    expect(await screen.findByText("$0.4200")).toBeTruthy();
    expect(screen.getByText("$5")).toBeTruthy();
    expect(screen.getByText("1234")).toBeTruthy();
    expect(
      screen.getByText("한도에 도달해 새 turn을 시작하지 않습니다."),
    ).toBeTruthy();
    expect(await screen.findByText("권한 요청: Bash")).toBeTruthy();

    const stream = await waitFor(() => {
      const [only] = FakeEventSource.opened;
      if (!only) throw new Error("no stream");
      return only;
    });
    expect(FakeEventSource.opened).toHaveLength(1);
    expect(stream.url).toBe(`/v1/sessions/${SESSION_ID}/events`);

    act(() => {
      stream.open();
      stream.emit("ev_1", "status", { phase: "running" });
      stream.emit("ev_2", "assistant", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Listing files" }] },
      });
      stream.emit("ev_3", "tool_use", {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      });
      // A resumed stream replays from Last-Event-ID; a frame seen once is
      // not drawn twice.
      stream.emit("ev_2", "assistant", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Listing files" }] },
      });
    });
    expect(await screen.findByText("Listing files")).toBeTruthy();
    expect(screen.getAllByText("Listing files")).toHaveLength(1);
    expect(screen.getByText("작업 중")).toBeTruthy();
    expect(screen.getByText("tool_use")).toBeTruthy();

    act(() => stream.fail());
    expect(
      await screen.findByText(
        "이벤트 연결이 끊겼습니다. 새로고침하면 다시 연결합니다.",
      ),
    ).toBeTruthy();
  });

  test("leaving the screen closes the stream", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    const stream = await waitFor(() => {
      const [only] = FakeEventSource.opened;
      if (!only) throw new Error("no stream");
      return only;
    });
    act(() => stream.open());
    await user.click(screen.getByRole("link", { name: "← 세션 목록" }));
    await screen.findByText("아직 세션이 없습니다.");
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
  });

  test("someone else's private session reads as not found and asks nothing more", async () => {
    const { api } = renderAt(`/sessions/${OTHER_ID}`, {
      "GET /v1/auth/me": () => json(200, memberMe()),
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        apiError(404, "NOT_FOUND", "Resource not found"),
    });
    expect(
      await screen.findByText(
        "이 세션을 찾을 수 없습니다. 지워졌거나 볼 권한이 없는 세션입니다.",
      ),
    ).toBeTruthy();
    expect(
      api.calls.filter((call) => call.path.startsWith("/v1/sessions")),
    ).toHaveLength(1);
    expect(FakeEventSource.opened).toHaveLength(0);
  });
});

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type {
  ListPendingRequestsResponse,
  ListProfilesResponse,
  ProfileSummary,
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
  onerror: ((event: Event) => void) | null = null;
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
    const message = new MessageEvent(event, {
      data: JSON.stringify(envelope),
      lastEventId: id,
    });
    this.dispatchEvent(message);
    // As in the browser: onerror is the handler for every "error" event,
    // a stream's own `event: error` frame included.
    if (event === "error") this.onerror?.(message);
  }
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
  }
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event("error"));
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

function profile(id: string, overrides: Partial<ProfileSummary> = {}) {
  return {
    id,
    model: `model-${id}`,
    tools: ["Read"],
    runtime_kind: "claude_agent_sdk",
    runtime_version: "1.0.0",
    billing: "metered",
    ...overrides,
  } as ProfileSummary;
}

const profiles: ListProfilesResponse = {
  items: [
    profile("default"),
    profile("fast"),
    profile("other-runtime", { runtime_version: "2.0.0" }),
    profile("free", { billing: "none" }),
  ],
};

const detailRoutes = {
  "GET /v1/auth/me": () => json(200, me()),
  "GET /v1/profiles": () => json(200, profiles),
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

  test("a next page that failed is asked for again by the retry button", async () => {
    const user = await setupUser();
    let nextCalls = 0;
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("cursor") === "next-1"
          ? ++nextCalls === 1
            ? apiError(503, "BACKEND_UNAVAILABLE", "down")
            : json(200, { items: [summary(OTHER_ID)], next_cursor: null })
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: "next-1",
            }),
    });

    await user.click(await screen.findByRole("button", { name: "더 보기" }));
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await screen.findByRole("link", { name: OTHER_ID });
    expect(screen.getByRole("link", { name: SESSION_ID })).toBeTruthy();
    expect(nextCalls).toBe(2);
  });

  test("a refresh that failed under a shown list is retried as a refresh", async () => {
    const user = await setupUser();
    let firstPageCalls = 0;
    const { services } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, me()),
      "GET /v1/sessions": () =>
        ++firstPageCalls === 2
          ? apiError(503, "BACKEND_UNAVAILABLE", "down")
          : json(200, {
              items: [summary(SESSION_ID, { status: "idle" })],
              next_cursor: null,
            }),
    });

    await screen.findByRole("link", { name: SESSION_ID });
    await services.queryClient.invalidateQueries({ queryKey: ["sessions"] });
    await user.click(await screen.findByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull(),
    );
    expect(firstPageCalls).toBe(3);
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
      screen.getByText(/진행 중인 turn이 있어 아직 확정되지 않았습니다/),
    ).toBeTruthy();
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

    // The session reporting an error is an event, not a lost connection.
    act(() =>
      stream.emit("ev_4", "error", { message: "engine crashed", code: "X" }),
    );
    expect(await screen.findByText("engine crashed")).toBeTruthy();
    expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull();

    act(() => stream.drop());
    expect(await screen.findByText("이벤트에 연결하는 중…")).toBeTruthy();
    act(() => stream.open());
    await waitFor(() =>
      expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull(),
    );

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

  test("a share taken back while open drops the detail and the stream", async () => {
    let visible = true;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        visible
          ? json(200, detail)
          : apiError(404, "NOT_FOUND", "Resource not found"),
    });
    const stream = await waitFor(() => {
      const [only] = FakeEventSource.opened;
      if (!only) throw new Error("no stream");
      return only;
    });
    act(() => stream.open());
    await screen.findByText("권한 요청: Bash");

    visible = false;
    await act(() =>
      services.queryClient.refetchQueries({
        queryKey: ["sessions", SESSION_ID],
        exact: true,
      }),
    );
    expect(
      await screen.findByText(
        "이 세션을 찾을 수 없습니다. 지워졌거나 볼 권한이 없는 세션입니다.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("권한 요청: Bash")).toBeNull();
    expect(stream.readyState).toBe(FakeEventSource.CLOSED);
  });

  test("a turn that ended without a cost report is not called running", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/usage`]: () =>
        json(200, {
          ...usage,
          cost: { ...usage.cost, open_turn_count: 0, unreported_turn_count: 1 },
        }),
    });
    expect(
      await screen.findByText(/비용을 보고하지 않고 끝난 turn이 있어/),
    ).toBeTruthy();
    expect(screen.queryByText(/진행 중인 turn이 있어/)).toBeNull();
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

describe("session profile", () => {
  test("offers only profiles with the same runtime and billing, and moves the session", async () => {
    const user = await setupUser();
    let revision = 3;
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, revision }),
      [`POST /v1/sessions/${SESSION_ID}/profile`]: () => {
        revision = 4;
        return json(200, { receipt_id: "r1", receipt_status: "succeeded" });
      },
    });

    const select = await screen.findByRole("combobox", {
      name: "다음 turn부터 쓸 프로필",
    });
    expect(
      Array.from(select.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["fast"]);

    const reads = () =>
      api.calls.filter(
        (call) =>
          call.method === "GET" && call.path === `/v1/sessions/${SESSION_ID}`,
      ).length;
    const before = reads();
    await user.click(screen.getByRole("button", { name: "프로필 바꾸기" }));
    expect(
      await screen.findByText("다음 turn부터 fast 프로필로 돕니다."),
    ).toBeTruthy();
    const [post] = api.calls.filter((call) => call.method === "POST");
    expect(post?.body).toEqual({ expected_revision: 3, profile_id: "fast" });
    expect(post?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  test("shows why the server refused", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/profile`]: () =>
        apiError(
          422,
          "UNSUPPORTED_CAPABILITY",
          "profile fast is not allowed for repository demo",
        ),
    });
    await user.click(
      await screen.findByRole("button", { name: "프로필 바꾸기" }),
    );
    expect(
      await screen.findByText(
        "이 프로필로 바꿀 수 없습니다. profile fast is not allowed for repository demo",
      ),
    ).toBeTruthy();
  });

  test("a key without sessions:control cannot change it", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/auth/me": () =>
        json(200, me(["sessions:read", "sessions:write"], "member")),
    });
    const button = await screen.findByRole("button", {
      name: "프로필 바꾸기",
    });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("says so when the current profile left the catalog", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/profiles": () => json(200, { items: [profile("fast")] }),
    });
    expect(
      await screen.findByText(
        "지금 프로필이 카탈로그에 없어 다른 프로필로 바꿀 수 없습니다.",
      ),
    ).toBeTruthy();
  });
});

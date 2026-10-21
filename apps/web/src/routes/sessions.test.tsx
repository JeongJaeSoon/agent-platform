import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ListPendingRequestsResponse,
  ListProfilesResponse,
  ProfileSummary,
  SessionDetail,
  SessionSummary,
  SessionUsageResponse,
} from "@agent-platform/contracts";
import { setupUser } from "@agent-platform/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, act, within } = await appHarness();

const SESSION_ID = "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const OTHER_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const AT = "2026-10-11T08:14:02.000Z";
// Far enough ahead that a request still takes answers.
const LATER = "2099-01-01T00:00:00.000Z";
const TERMINATE_ACCEPTED = {
  receipt_id: RECEIPT_ID,
  receipt_status: "accepted",
  external_effects_reverted: false,
};

interface Connection {
  readonly request: Request;
  push(text: string): void;
  end(): void;
}

/**
 * The server's side of the session's event stream. Each connection the
 * screen asks for waits until the test calls open(), so the screen's
 * "connecting" state can be seen; frames go to the newest open one.
 */
class FakeEventStream {
  readonly requests: Request[] = [];
  private waiting: (() => void)[] = [];
  private live: Connection | null = null;
  private refusal: (() => Response) | null = null;

  readonly route = (request: Request): Promise<Response> => {
    this.requests.push(request);
    if (this.refusal) return Promise.resolve(this.refusal());
    return new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
      this.waiting.push(() => resolve(this.connect(request)));
    });
  };

  private connect(request: Request): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });
    request.signal.addEventListener("abort", () =>
      controller.error(new DOMException("aborted", "AbortError")),
    );
    this.live = {
      request,
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  }

  open() {
    for (const release of this.waiting.splice(0)) release();
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
    this.live?.push(
      `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`,
    );
  }
  /** The connection ends; the screen reconnects with Last-Event-ID. */
  drop() {
    this.live?.end();
    this.live = null;
  }
  /** The server refuses every connection from now on (the share is gone). */
  fail() {
    this.refusal = () => apiError(404, "NOT_FOUND", "Resource not found");
    this.drop();
  }
  /** Whether the screen has let go of the newest connection. */
  get closed() {
    return this.requests.at(-1)?.signal.aborted ?? false;
  }
}

let stream: FakeEventStream;
beforeEach(() => {
  stream = new FakeEventStream();
});
const EVENTS_ROUTE = `GET /v1/sessions/${SESSION_ID}/events`;

function summary(id: string, overrides: Partial<SessionSummary> = {}) {
  return {
    id,
    revision: 3,
    admission_state: "active",
    status: "running",
    runtime: {
      kind: "claude_agent_sdk",
      version: "1.0.0",
      profile_id: "default",
    },
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
  [EVENTS_ROUTE]: (request: Request) => stream.route(request),
};

describe("approval inbox", () => {
  const waitingRoutes = (items: unknown[], next_cursor: string | null) => ({
    "GET /v1/auth/me": () => json(200, me()),
    "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    "GET /v1/sessions?status=needs_input": () =>
      json(200, { items, next_cursor }),
    [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
      json(200, { items: [{ ...pending.items[0], expires_at: LATER }] }),
    [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
      json(200, { items: [] }),
  });

  test("gathers the waiting sessions under the same count as the sidebar badge", async () => {
    renderAt(
      "/sessions",
      waitingRoutes(
        [
          summary(SESSION_ID, { status: "needs_input" }),
          summary(OTHER_ID, { status: "needs_input" }),
        ],
        null,
      ),
    );
    const inbox = await screen.findByRole("region", { name: "승인 대기" });
    expect(
      await within(inbox).findByText("답을 기다리는 세션 2개"),
    ).toBeTruthy();
    expect(await screen.findByText("답변 대기 2건")).toBeTruthy();
    expect(
      within(inbox)
        .getByRole("link", { name: `세션 열기 ${SESSION_ID}` })
        .getAttribute("href"),
    ).toBe(`/sessions/${SESSION_ID}`);
    expect(await within(inbox).findByText("권한 요청: Bash")).toBeTruthy();
  });

  test("a longer first page reads as more, as the badge does", async () => {
    renderAt(
      "/sessions",
      waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], "next"),
    );
    expect(await screen.findByText("답을 기다리는 세션 1개 이상")).toBeTruthy();
    expect(await screen.findByText("답변 대기 1건 이상")).toBeTruthy();
  });

  test("answers from the inbox and reads the waiting sessions again", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions", {
      ...waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], null),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const waitingReads = () =>
      api.calls.filter((call) => call.search === "?status=needs_input").length;
    const allow = await screen.findByRole("button", { name: "허용" });
    const before = waitingReads();
    await user.click(allow);
    expect(
      await screen.findByText("답을 보냈습니다. 세션이 이어서 진행합니다."),
    ).toBeTruthy();
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
    await waitFor(() => expect(waitingReads()).toBeGreaterThan(before));
  });

  test("a session answered from the keyboard leaves and hands focus to the inbox heading", async () => {
    const user = await setupUser();
    let waiting = [summary(SESSION_ID, { status: "needs_input" })];
    renderAt("/sessions", {
      ...waitingRoutes([], null),
      "GET /v1/sessions?status=needs_input": () =>
        json(200, { items: waiting, next_cursor: null }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        waiting = [];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const allow = await screen.findByRole("button", { name: "허용" });
    allow.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("답을 기다리는 세션이 없습니다."),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "승인 대기" }),
      ),
    );
  });

  test("says so when nothing is waiting", async () => {
    renderAt("/sessions", waitingRoutes([], null));
    expect(
      await screen.findByText("답을 기다리는 세션이 없습니다."),
    ).toBeTruthy();
  });
});

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
    expect(screen.getByText("default · claude_agent_sdk 1.0.0")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "더 보기" }));
    await screen.findByRole("link", { name: OTHER_ID });
    expect(screen.queryByRole("button", { name: "더 보기" })).toBeNull();
    expect(
      api.calls.filter(
        (call) =>
          call.path === "/v1/sessions" && call.search !== "?status=needs_input",
      ),
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

  test("in en the list speaks English", async () => {
    renderAt(
      "/sessions",
      {
        "GET /v1/auth/me": () => json(200, me()),
        "GET /v1/sessions": () =>
          json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
      },
      "en",
    );
    const link = await screen.findByRole("link", { name: SESSION_ID });
    expect(link.textContent).toBe(SESSION_ID.slice(0, 8));
    expect(screen.getByRole("list", { name: "Sessions table" })).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.queryByText(/세션/)).toBeNull();
    expect(screen.getAllByText("Oct 11, 2026, 17:14").length).toBeGreaterThan(
      0,
    );
  });

  test("a row's link opens the session inside the app", async () => {
    const user = await setupUser();
    const { history } = renderAt("/sessions", {
      ...detailRoutes,
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await user.click(await screen.findByRole("link", { name: SESSION_ID }));
    await waitFor(() =>
      expect(history.location.pathname).toBe(`/sessions/${SESSION_ID}`),
    );
    expect(await screen.findByText("권한 요청: Bash")).toBeTruthy();
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

    await waitFor(() => expect(stream.requests).toHaveLength(1));
    expect(stream.requests[0]?.headers.get("last-event-id")).toBeNull();
    expect(stream.requests[0]?.headers.get("x-requested-with")).toBe(
      "agent-platform-web",
    );

    await act(async () => stream.open());
    act(() => {
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
    expect(screen.getByText("도구 호출")).toBeTruthy();
    expect(screen.queryByText("tool_use")).toBeNull();
    // Only the latest status is announced; the list itself is not live.
    const list = screen.getByText("Listing files").closest("ol");
    expect(list?.getAttribute("aria-live")).toBeNull();
    expect(document.querySelector("output.sr-only")?.textContent).toBe(
      "작업 중",
    );
    // The pending section says how many are waiting; the overview does not.
    expect(screen.getAllByText("대기 중인 요청")).toHaveLength(1);

    act(() =>
      stream.emit("ev_5", "system", {
        type: "system",
        subtype: "sdk_event",
        native_type: "command_lifecycle",
      }),
    );
    expect(screen.queryByText("command_lifecycle")).toBeNull();
    const user = await setupUser();
    await user.click(screen.getByLabelText("내부 이벤트도 보기"));
    expect(await screen.findByText("command_lifecycle")).toBeTruthy();

    // The session reporting an error is an event, not a lost connection.
    act(() =>
      stream.emit("ev_4", "error", { message: "engine crashed", code: "X" }),
    );
    expect(await screen.findByText("engine crashed")).toBeTruthy();
    expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull();

    // A dropped connection resumes after the last event drawn, and what
    // arrives after it is drawn too.
    act(() => stream.drop());
    expect(await screen.findByText("이벤트에 연결하는 중…")).toBeTruthy();
    expect(stream.requests.at(-1)?.headers.get("last-event-id")).toBe("ev_4");
    await act(async () => stream.open());
    await waitFor(() =>
      expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull(),
    );
    act(() =>
      stream.emit("ev_6", "assistant", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Back again" }] },
      }),
    );
    expect(await screen.findByText("Back again")).toBeTruthy();

    act(() => stream.fail());
    expect(
      await screen.findByText(
        "이벤트 연결이 끊겼습니다. 새로고침하면 다시 연결합니다.",
      ),
    ).toBeTruthy();
  });

  test("a tool result keeps its tool's name after the call leaves the window", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      stream.emit("ev_call", "tool_use", {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "make" },
            },
          ],
        },
      });
      stream.emit("ev_result", "tool_result", {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "built",
      });
      for (let i = 0; i < 199; i += 1) {
        stream.emit(`ev_s${i}`, "status", { phase: "running" });
      }
    });
    expect(await screen.findByText("Bash 결과 · 성공 · built")).toBeTruthy();
    expect(screen.queryByText("Bash: make")).toBeNull();
  });

  test("thinking ticks fold into one line and an empty message draws no card", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => {
      for (const id of ["ev_t1", "ev_t2", "ev_t3"]) {
        stream.emit(id, "system", {
          type: "system",
          subtype: "thinking_tokens",
        });
      }
      // The next turn's tick starts its own line.
      stream.emit(
        "ev_t4",
        "system",
        { type: "system", subtype: "thinking_tokens" },
        "2",
      );
      stream.emit("ev_empty", "assistant", {
        type: "assistant",
        message: { content: [] },
      });
    });
    expect(await screen.findByText("생각 중 (3)")).toBeTruthy();
    expect(screen.getByText("생각 중 (1)")).toBeTruthy();
    const list = screen.getByRole("list", { name: "이벤트" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
  });

  test("leaving the screen closes the stream", async () => {
    const user = await setupUser();
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await user.click(screen.getByRole("link", { name: "← 세션 목록" }));
    await screen.findByText("아직 세션이 없습니다.");
    expect(stream.closed).toBe(true);
  });

  test("moving to another session shows its stream connecting, not the old one closed", async () => {
    const next = new FakeEventStream();
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        json(200, { ...detail, id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
        json(200, { ...usage, session_id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
        json(200, { items: [] }),
      [`GET /v1/sessions/${OTHER_ID}/events`]: (request: Request) =>
        next.route(request),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await waitFor(() =>
      expect(screen.queryByText("이벤트에 연결하는 중…")).toBeNull(),
    );

    act(() => history.push(`/sessions/${OTHER_ID}`));
    await waitFor(() => expect(next.requests).toHaveLength(1));
    await act(async () => next.open());
    // Back to a session whose detail is cached: the new stream starts in the
    // same render that stops the old one, and the old one's close lands
    // while the new one is still connecting.
    act(() => history.push(`/sessions/${SESSION_ID}`));
    await waitFor(() => expect(stream.requests).toHaveLength(2));
    expect(next.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText("이벤트에 연결하는 중…")).toBeTruthy();
    expect(
      screen.queryByText(
        "이벤트 연결이 끊겼습니다. 새로고침하면 다시 연결합니다.",
      ),
    ).toBeNull();
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
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
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
    expect(stream.closed).toBe(true);
  });

  test("a stream refused for a lost login sends the reader to log in", async () => {
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [EVENTS_ROUTE]: () =>
        apiError(401, "UNAUTHORIZED", "Authentication required"),
    });
    await waitFor(() => expect(history.location.pathname).toBe("/login"));
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
      api.calls.filter((call) => call.path.startsWith("/v1/sessions/")),
    ).toHaveLength(1);
    expect(stream.requests).toHaveLength(0);
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
        return json(200, {
          receipt_id: RECEIPT_ID,
          receipt_status: "succeeded",
        });
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

  test("allows a permission request from the keyboard; the answered request leaves", async () => {
    const user = await setupUser();
    let open = [{ ...pending.items[0], expires_at: LATER }];
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        open = [];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const allow = await screen.findByRole("button", { name: "허용" });
    allow.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText("답을 보냈습니다. 세션이 이어서 진행합니다."),
    ).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/answers`);
    expect(post?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
    expect(post?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByText("답을 기다리는 요청이 없습니다."),
    ).toBeTruthy();
    // The answered card took focus with it; the notice holds it now.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "답을 보냈습니다. 세션이 이어서 진행합니다.",
      ),
    );
  });

  test("after an answer the keyboard moves on to the next request", async () => {
    const user = await setupUser();
    const second = {
      ...pending.items[0],
      request_id: "req_2",
      tool: "Write",
      expires_at: LATER,
    };
    let open = [{ ...pending.items[0], expires_at: LATER }, second];
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        open = [second];
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const [allow] = await screen.findAllByRole("button", { name: "허용" });
    allow?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByText("권한 요청: Bash")).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.closest("article")?.textContent).toContain(
        "권한 요청: Write",
      ),
    );
  });

  test("focus moves on too when an event takes the card before the answer's receipt", async () => {
    const user = await setupUser();
    const second = {
      ...pending.items[0],
      request_id: "req_2",
      tool: "Write",
      expires_at: LATER,
    };
    let open = [{ ...pending.items[0], expires_at: LATER }, second];
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let posted = false;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        posted = true;
        return held;
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const [allow] = await screen.findAllByRole("button", { name: "허용" });
    allow?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(true));
    open = [second];
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    // waitFor's polling starves the refetch while the answer is held, so the
    // test waits on the clock instead.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByText("권한 요청: Bash")).toBeNull();
    expect(document.activeElement?.closest("article")?.textContent).toContain(
      "권한 요청: Write",
    );
    await act(async () =>
      release(
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
      ),
    );
  });

  test("an answer refused after an event took its card still says why", async () => {
    const user = await setupUser();
    let open = [{ ...pending.items[0], expires_at: LATER }];
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let posted = false;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { items: open }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
        posted = true;
        return held;
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const allow = await screen.findByRole("button", { name: "허용" });
    allow.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(true));
    open = [];
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    // As above, the clock instead of waitFor while the answer is held.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByText("권한 요청: Bash")).toBeNull();
    await act(async () =>
      release(apiError(409, "REQUEST_EXPIRED", "request expired")),
    );
    expect(
      await screen.findByText("이미 답했거나 만료되었거나 닫힌 요청입니다."),
    ).toBeTruthy();
  });

  test("a denial carries its reason, and an expired request says why it was refused", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { items: [{ ...pending.items[0], expires_at: LATER }] }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        apiError(409, "REQUEST_EXPIRED", "request expired"),
    });
    await user.click(await screen.findByRole("button", { name: "거부" }));
    await user.keyboard("not now");
    await user.click(screen.getByRole("button", { name: "거부 보내기" }));
    expect(
      await screen.findByText("이미 답했거나 만료되었거나 닫힌 요청입니다."),
    ).toBeTruthy();
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "deny",
      reason: "not now",
    });
  });

  test("answers a question with the picked option", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          items: [
            {
              kind: "question",
              request_id: "req_q",
              turn_id: "1",
              attempt_id: "att_1",
              created_at: AT,
              expires_at: LATER,
              questions: [
                {
                  question_id: "q1",
                  prompt: "Which branch?",
                  options: [
                    { option_id: "main", label: "main" },
                    { option_id: "dev", label: "dev" },
                  ],
                  multi_select: false,
                  allow_free_text: false,
                },
              ],
            },
          ],
        }),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    await user.click(await screen.findByRole("radio", { name: "dev" }));
    await user.click(screen.getByRole("button", { name: "답 보내기" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        request_id: "req_q",
        kind: "question",
        answers: [{ question_id: "q1", selected_option_ids: ["dev"] }],
      }),
    );
  });

  test("interrupts the running turn and shows the stop the stream reports", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/interrupt`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const stop = await screen.findByRole("button", {
      name: "지금 turn 멈추기",
    });
    stop.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByText(
        "요청을 보냈습니다. 바뀐 상태는 위 개요에 반영됩니다.",
      ),
    ).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/interrupt`);
    expect(post?.body).toEqual({ target_turn_id: "1" });

    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => stream.emit("ev_1", "status", { phase: "interrupting" }));
    await waitFor(() =>
      expect(document.querySelector("output.sr-only")?.textContent).toBe(
        "멈추는 중",
      ),
    );
  });

  test("after a pause the keyboard lands on resume", async () => {
    const user = await setupUser();
    let state = { ...detail };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/pause`]: () => {
        state = {
          ...detail,
          admission_state: "paused",
          status: "idle",
          current_turn_id: null,
        };
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    pause.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "일시 정지" })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("다시 시작"),
    );
  });

  test("a running command keeps its button focused and takes no second press", async () => {
    const user = await setupUser();
    let posts = 0;
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/pause`]: () => {
        posts += 1;
        return held;
      },
    });
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    pause.focus();
    await user.keyboard("{Enter}");
    // The clock instead of waitFor while the command is held, as above.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pause.getAttribute("aria-disabled")).toBe("true");
    expect(pause.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(pause);
    await user.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(posts).toBe(1);
    await act(async () =>
      release(
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
      ),
    );
  });

  test("a refused command does not take the keyboard back on a later change", async () => {
    const user = await setupUser();
    let state = { ...detail };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/pause`]: () =>
        apiError(409, "PAUSE_COMMITTING", "pause committing"),
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    pause.focus();
    await user.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The reader moves on; the turn ending later changes the controls.
    (document.activeElement as HTMLElement | null)?.blur();
    state = { ...detail, current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "idle" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      screen.queryByRole("button", { name: "지금 turn 멈추기" }),
    ).toBeNull();
    expect(document.activeElement?.tagName).toBe("BODY");
  });

  test("terminating asks first and sends the session's revision", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/terminate`]: () =>
        json(202, TERMINATE_ACCEPTED),
    });
    await user.click(await screen.findByRole("button", { name: "세션 종료" }));
    const dialog = await screen.findByRole("dialog", {
      name: "세션을 종료할까요?",
    });
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "종료" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        expected_revision: 3,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("a terminate whose button left before the receipt hands the keyboard to its outcome", async () => {
    const user = await setupUser();
    let state = { ...detail };
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let posted = false;
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/terminate`]: () => {
        posted = true;
        return held;
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const terminate = await screen.findByRole("button", { name: "세션 종료" });
    terminate.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "세션을 종료할까요?",
    });
    within(dialog).getByRole("button", { name: "종료" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posted).toBe(true));
    state = { ...detail, admission_state: "stopping", current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "running" }));
    // The clock instead of waitFor while the command is held, as above.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(screen.queryByRole("button", { name: "세션 종료" })).toBeNull();
    await act(async () => release(json(202, TERMINATE_ACCEPTED)));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "요청을 보냈습니다. 바뀐 상태는 위 개요에 반영됩니다.",
      ),
    );
  });

  test("sends a message with Ctrl+Enter and names the turn it became", async () => {
    const user = await setupUser();
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () =>
        json(202, {
          turn_id: "2",
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        }),
    });
    await user.click(await screen.findByRole("textbox", { name: "메시지" }));
    await user.keyboard("next step{Control>}{Enter}{/Control}");
    expect(
      await screen.findByText("메시지를 보냈습니다(turn 2)."),
    ).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/messages`);
    expect(post?.body).toEqual({ message: "next step", mode: "enqueue" });
    expect(
      (screen.getByRole("textbox", { name: "메시지" }) as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });

  test("a stopped session offers resume and takes no message", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, {
          ...detail,
          admission_state: "stopped",
          status: "stopped",
          current_turn_id: null,
        }),
    });
    expect(
      await screen.findByRole("button", { name: "다시 시작" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "지금 turn 멈추기" }),
    ).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "메시지" }) as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText("진행 중인 세션만 메시지를 받습니다."),
    ).toBeTruthy();
  });

  test("a key without the scopes sees each action disabled and why", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      "GET /v1/auth/me": () => json(200, me(["sessions:read"], "member")),
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { items: [{ ...pending.items[0], expires_at: LATER }] }),
    });
    const allow = await screen.findByRole("button", { name: "허용" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("sessions:approve 권한이 있어야 할 수 있습니다."),
    ).toBeTruthy();
    const stop = screen.getByRole("button", { name: "지금 turn 멈추기" });
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("sessions:control 권한이 있어야 할 수 있습니다."),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "메시지" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText("sessions:write 권한이 있어야 할 수 있습니다."),
    ).toBeTruthy();
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

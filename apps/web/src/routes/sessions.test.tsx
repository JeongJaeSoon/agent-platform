import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ListPendingRequestsResponse,
  ListProfilesResponse,
  ProfileSummary,
  SessionDetail,
  SessionSummary,
  SessionUsageResponse,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, act, within, fireEvent } =
  await appHarness();

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
      model: "model-default",
      permission_mode: "default",
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
  answerable: true,
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
    repository_mode: "required",
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
      json(200, {
        answerable: true,
        items: [{ ...pending.items[0], expires_at: LATER }],
      }),
    [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
      json(200, { answerable: true, items: [] }),
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
    const inbox = await screen.findByRole("region", { name: "답변 대기" });
    // The count sits beside the heading as a badge; no line of its own.
    const badge = (await within(inbox).findByText("답을 기다리는 세션 2개"))
      .parentElement as HTMLElement;
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.textContent).toBe("2답을 기다리는 세션 2개");
    expect(
      badge.parentElement?.contains(
        screen.getByRole("heading", { name: "답변 대기" }),
      ),
    ).toBe(true);
    expect(await screen.findByText("답변 대기 2개")).toBeTruthy();
    expect(
      within(inbox)
        .getByRole("link", { name: `세션 열기 ${SESSION_ID}` })
        .getAttribute("href"),
    ).toBe(`/sessions/${SESSION_ID}`);
    // The session link rides on the card's title line, not a line of its own.
    const titleLine = (await within(inbox).findByText("권한 요청: Bash"))
      .parentElement as HTMLElement;
    expect(titleLine.textContent).toMatch(
      new RegExp(`^권한 요청: Bash·${SESSION_ID.slice(0, 8)}…·.+까지$`),
    );
    expect(
      titleLine.contains(
        within(inbox).getByRole("link", { name: `세션 열기 ${SESSION_ID}` }),
      ),
    ).toBe(true);
    // One column as wide as the session table below, 16px between blocks.
    const list = within(inbox).getAllByRole("list")[0] as HTMLElement;
    expect(list.className).not.toContain("grid-cols-2");
    expect(list.className).toContain("gap-[var(--ap-space-block)]");
    expect(inbox.parentElement?.className).toContain(
      "gap-[var(--ap-space-block)]",
    );
    expect(inbox.className).not.toContain("border");
  });

  test("a longer first page reads as more, as the badge does", async () => {
    renderAt(
      "/sessions",
      waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], "next"),
    );
    const count = await screen.findByText("답을 기다리는 세션 1개 이상");
    expect(count.parentElement?.textContent).toBe(
      "1+답을 기다리는 세션 1개 이상",
    );
    expect(await screen.findByText("답변 대기 1개 이상")).toBeTruthy();
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
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
    await waitFor(() => expect(waitingReads()).toBeGreaterThan(before));
  });

  test("an answer from the inbox reads the waiting tab again", async () => {
    const user = await setupUser();
    const { api } = renderAt("/sessions?status=needs_input", {
      ...waitingRoutes([summary(SESSION_ID, { status: "needs_input" })], null),
      [`POST /v1/sessions/${SESSION_ID}/answers`]: () =>
        json(202, { receipt_id: RECEIPT_ID, receipt_status: "accepted" }),
    });
    const tab = await screen.findByRole("tabpanel");
    await within(tab).findByRole("link", { name: SESSION_ID });
    const waitingReads = () =>
      api.calls.filter((call) => call.search === "?status=needs_input").length;
    await waitFor(() => expect(waitingReads()).toBe(2));
    await user.click(await screen.findByRole("button", { name: "허용" }));
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    // The inbox's page and the tab's list are separate queries: both read again.
    await waitFor(() => expect(waitingReads()).toBeGreaterThanOrEqual(4));
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
        screen.getByRole("heading", { name: "답변 대기" }),
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
    const row = link.closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText("쉬는 중")).toBeTruthy();
    expect(screen.getByText("default · claude_agent_sdk 1.0.0")).toBeTruthy();
    // An idle session that still takes input: "작업 상태" and "세션 상태" differ.
    expect(row.textContent).toContain("작업 상태: 쉬는 중");
    expect(row.textContent).toContain("세션 상태: 열림");
    expect(screen.getByText("열림")).toBeTruthy();
    expect(screen.getByText(/나에게 공유된 세션입니다/)).toBeTruthy();

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
    expect(link.textContent).toBe(SESSION_ID);
    expect(screen.getByRole("table", { name: "Sessions table" })).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
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

  test("a status tab reads only that status and keeps it in the address", async () => {
    const user = await setupUser();
    const { api, history } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) => {
        const status = new URL(request.url).searchParams.get("status");
        if (status === "failed") {
          return json(200, {
            items: [summary(OTHER_ID, { status: "failed" })],
            next_cursor: null,
          });
        }
        if (status === null) {
          return json(200, { items: [summary(SESSION_ID)], next_cursor: null });
        }
        return json(200, { items: [], next_cursor: null });
      },
    });

    const tabs = await screen.findByRole("tablist", { name: "상태로 보기" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["전체", "답변 대기", "작업 중", "쉬는 중", "멈춤", "실패"]);
    expect(
      within(tabs)
        .getByRole("tab", { name: "전체" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    await screen.findByRole("link", { name: SESSION_ID });

    await user.click(within(tabs).getByRole("tab", { name: "실패" }));
    await screen.findByRole("link", { name: OTHER_ID });
    expect(screen.queryByRole("link", { name: SESSION_ID })).toBeNull();
    expect(history.location.search).toContain("status=failed");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/v1/sessions" && call.search === "?status=failed",
      ),
    ).toBe(true);

    await user.click(within(tabs).getByRole("tab", { name: "멈춤" }));
    expect(await screen.findByText("이 상태의 세션이 없습니다.")).toBeTruthy();

    await user.click(within(tabs).getByRole("tab", { name: "전체" }));
    await screen.findByRole("link", { name: SESSION_ID });
    expect(history.location.search).not.toContain("status=");
  });

  test("every refresh of the full list reaches the status tab, not just the first", async () => {
    const user = await setupUser();
    const { api, services } = renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("status") === "failed"
          ? json(200, {
              items: [summary(OTHER_ID, { status: "failed" })],
              next_cursor: null,
            })
          : json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    await screen.findByRole("link", { name: SESSION_ID });
    // The full list stays cached, unmounted, behind the status tab.
    await user.click(screen.getByRole("tab", { name: "실패" }));
    await screen.findByRole("link", { name: OTHER_ID });
    const failedReads = () =>
      api.calls.filter((call) => call.search === "?status=failed").length;
    await waitFor(() => expect(failedReads()).toBe(1));
    for (const expected of [2, 3]) {
      await act(() =>
        services.queryClient.invalidateQueries({
          queryKey: ["sessions"],
          exact: true,
        }),
      );
      await waitFor(() => expect(failedReads()).toBe(expected));
    }
  });

  test("an address with a status opens on that tab", async () => {
    renderAt("/sessions?status=idle", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": (request) =>
        new URL(request.url).searchParams.get("status") === "idle"
          ? json(200, {
              items: [summary(OTHER_ID, { status: "idle" })],
              next_cursor: null,
            })
          : json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    const tab = await screen.findByRole("tab", { name: "쉬는 중" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("link", { name: OTHER_ID });
  });

  test("an unknown status in the address opens every session", async () => {
    renderAt("/sessions?status=bogus", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () =>
        json(200, { items: [summary(SESSION_ID)], next_cursor: null }),
    });
    const tab = await screen.findByRole("tab", { name: "전체" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("link", { name: SESSION_ID });
  });

  test("the new session button is off and says why", async () => {
    renderAt("/sessions", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      "GET /v1/sessions": () => json(200, { items: [], next_cursor: null }),
    });
    const button = await screen.findByRole("button", { name: "새 세션" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe(
      "웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요.",
    );
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
    // Why no new turn starts sits above the composer it holds back.
    expect(
      await within(screen.getByRole("tabpanel")).findByText(
        "한도에 도달해 새 turn을 시작하지 않습니다.",
      ),
    ).toBeTruthy();
    await setupInfo();
    expect(screen.getByText("BUDGET_EXCEEDED")).toBeTruthy();
    const info = within(screen.getByRole("tabpanel"));
    expect(info.getByText("$0.4200")).toBeTruthy();
    expect(screen.getByText("$5")).toBeTruthy();
    expect(info.getByText("1234")).toBeTruthy();
    expect(
      info.getByText(/진행 중인 turn이 있어 아직 확정되지 않았습니다/),
    ).toBeTruthy();
    expect(
      info.getByText("한도에 도달해 새 turn을 시작하지 않습니다."),
    ).toBeTruthy();
    await (await setupUser()).click(screen.getByRole("tab", { name: "진행" }));
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
    expect(
      screen.getByRole("tabpanel").querySelector("output.sr-only")?.textContent,
    ).toBe("작업 중");
    expect(
      screen.getByRole("complementary", { name: "답변과 승인" }),
    ).toBeTruthy();

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
    await user.click(screen.getByRole("link", { name: "세션 목록" }));
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
        json(200, { answerable: true, items: [] }),
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
    await setupInfo();
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
  // The user's call (2026-10-24): a session picks its model only; the
  // profile belongs to the agent, so the screen offers no change mid-session.
  test("offers no profile change and shows the model the session runs instead", async () => {
    const { api } = renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const header = (
      await screen.findByRole("button", { name: "일시 정지" })
    ).closest("header") as HTMLElement;
    expect(header.textContent).toContain("model-default");
    expect(screen.queryByRole("button", { name: "프로필 바꾸기" })).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "다음 작업부터 쓸 프로필" }),
    ).toBeNull();
    expect(api.calls.some((call) => call.path === "/v1/profiles")).toBe(false);
  });

  test("allows a permission request from the keyboard; the answered request leaves", async () => {
    const user = await setupUser();
    let open = [{ ...pending.items[0], expires_at: LATER }];
    const { api } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: open }),
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
    expect(await screen.findByText("답을 보냈습니다.")).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/answers`);
    expect(post?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
    expect(post?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다."),
    ).toBeTruthy();
    expect(
      screen.getAllByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다."),
    ).toHaveLength(1);
    expect(screen.getByText("답을 보냈습니다.").tagName).toBe("OUTPUT");
    expect(screen.getByText("답을 보냈습니다.").closest("aside")).toBeTruthy();
    // The answered card took focus with it; the visible notice holds it now.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("답을 보냈습니다."),
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
        json(200, { answerable: true, items: open }),
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
        json(200, { answerable: true, items: open }),
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
        json(200, { answerable: true, items: open }),
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
        json(200, {
          answerable: true,
          items: [{ ...pending.items[0], expires_at: LATER }],
        }),
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
          answerable: true,
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
        "요청을 보냈습니다. 바뀐 상태는 위 '상태'에 보입니다.",
      ),
    ).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/interrupt`);
    expect(post?.body).toEqual({ target_turn_id: "1" });

    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    act(() => stream.emit("ev_1", "status", { phase: "interrupting" }));
    await waitFor(() =>
      expect(
        screen.getByRole("tabpanel").querySelector("output.sr-only")
          ?.textContent,
      ).toBe("멈추는 중"),
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
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "다시 시작",
      ),
    );
  });

  test("after resume the keyboard waits out resuming on the outcome and lands on pause, never on terminate", async () => {
    const user = await setupUser();
    let state = {
      ...detail,
      admission_state: "paused",
      status: "idle",
      current_turn_id: null,
    };
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
      [`POST /v1/sessions/${SESSION_ID}/resume`]: () => {
        state = { ...state, admission_state: "resuming" };
        return json(202, {
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        });
      },
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    const resume = await screen.findByRole("button", { name: "다시 시작" });
    resume.focus();
    await user.keyboard("{Enter}");
    // While resuming terminate is the only button; Enter there would open
    // its dialog.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "다시 시작" })).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "요청을 보냈습니다. 바뀐 상태는 위 '상태'에 보입니다.",
      ),
    );
    state = { ...detail, current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "idle" }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "일시 정지",
      ),
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
    // It stops a running session, so it is announced as an alert.
    const dialog = await screen.findByRole("alertdialog", {
      name: "세션을 종료할까요?",
    });
    expect(api.calls.some((call) => call.method === "POST")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "종료" }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
        expected_revision: 3,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
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
    const dialog = await screen.findByRole("alertdialog", {
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
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "요청을 보냈습니다. 바뀐 상태는 위 '상태'에 보입니다.",
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
    await screen.findByText("권한 요청: Bash");
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step{Control>}{Enter}{/Control}");
    expect(
      await screen.findByText("메시지를 보냈습니다(turn 2)."),
    ).toBeTruthy();
    const post = api.calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/v1/sessions/${SESSION_ID}/messages`);
    expect(post?.body).toEqual({ message: "next step", mode: "enqueue" });
    expect(
      (
        screen.getByRole("textbox", {
          name: "다음 지시",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  /** Sends by mouse and holds the receipt; focus has left the send button. */
  async function sendHeldByMouse(routes: Parameters<typeof renderAt>[1] = {}) {
    const user = await setupUser();
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      ...routes,
      [`POST /v1/sessions/${SESSION_ID}/messages`]: () => held,
    });
    await waitFor(() => expect(stream.requests).toHaveLength(1));
    await act(async () => stream.open());
    await screen.findByText("권한 요청: Bash");
    await user.click(await screen.findByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("next step");
    const send = screen.getByRole("button", { name: "보내기" });
    await user.click(send);
    // The clock instead of waitFor while the command is held, as above.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((send as HTMLButtonElement).disabled).toBe(true);
    // Chrome drops focus from a button that turns disabled. The DOM here
    // neither does that nor blurs a disabled button, but it does fall back
    // to the page when the focused element is removed.
    const stand = send.parentElement?.appendChild(
      document.createElement("input"),
    );
    stand?.focus();
    stand?.remove();
    expect(document.activeElement?.tagName).toBe("BODY");
    const answer = (response: Response) => act(async () => release(response));
    const accept = async () => {
      await answer(
        json(202, {
          turn_id: "2",
          receipt_id: RECEIPT_ID,
          receipt_status: "accepted",
        }),
      );
      expect(
        await screen.findByText("메시지를 보냈습니다(turn 2)."),
      ).toBeTruthy();
    };
    return { accept, answer };
  }

  test("a message sent by mouse gives the keyboard back to the field", async () => {
    const { accept } = await sendHeldByMouse();
    await accept();
    expect(
      document.activeElement ===
        screen.getByRole("textbox", { name: "다음 지시" }),
    ).toBe(true);
  });

  test("a reader who clicked elsewhere while sending keeps their place", async () => {
    const { accept } = await sendHeldByMouse();
    fireEvent.pointerDown(document.body);
    await accept();
    expect(document.activeElement?.tagName).toBe("BODY");
  });

  /** Sends, then the session pauses before the receipt comes back. */
  async function sendThenPause() {
    let state = { ...detail };
    const held = await sendHeldByMouse({
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, state),
    });
    state = { ...detail, admission_state: "paused", current_turn_id: null };
    act(() => stream.emit("ev_1", "status", { phase: "idle" }));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "다음 지시",
          }) as HTMLTextAreaElement
        ).disabled,
      ).toBe(true),
    );
    return held;
  }

  test("a message accepted after the session paused hands the keyboard to its notice", async () => {
    const { accept } = await sendThenPause();
    await accept();
    expect(document.activeElement?.textContent).toBe(
      "메시지를 보냈습니다(turn 2).",
    );
  });

  test("a message refused after the session paused says why on the notice it focuses", async () => {
    const { answer } = await sendThenPause();
    await answer(apiError(409, "SESSION_PAUSED", "session paused"));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe(
        "일시 정지된 세션입니다.",
      ),
    );
    // Said once, on the notice, not again under the field.
    expect(screen.getAllByText("일시 정지된 세션입니다.")).toHaveLength(1);
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
      (
        (await screen.findByRole("textbox", {
          name: "다음 지시",
        })) as HTMLTextAreaElement
      ).disabled,
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
        json(200, {
          answerable: true,
          items: [{ ...pending.items[0], expires_at: LATER }],
        }),
    });
    const allow = await screen.findByRole("button", { name: "허용" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    // Beside the buttons and in the answerers card, which says the same.
    expect(
      screen.getAllByText("sessions:approve 권한이 있어야 할 수 있습니다."),
    ).toHaveLength(2);
    expect(
      screen.queryByText("나는 이 세션의 요청에 답할 수 있습니다."),
    ).toBeNull();
    const stop = screen.getByRole("button", { name: "지금 turn 멈추기" });
    expect(stop.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText("sessions:control 권한이 있어야 할 수 있습니다."),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("textbox", { name: "다음 지시" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText("sessions:write 권한이 있어야 할 수 있습니다."),
    ).toBeTruthy();
  });

  test("someone who only sees the session through its share sees allow and deny disabled and why (94S-798)", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, {
          answerable: false,
          items: [{ ...pending.items[0], expires_at: LATER }],
        }),
    });
    const allow = await screen.findByRole("button", { name: "허용" });
    expect(allow.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "거부" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        "이 세션을 만든 사람, 에이전트 관리자, 워크스페이스 owner·admin만 답할 수 있습니다.",
      ),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("textbox", { name: "다음 지시" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});

async function setupInfo() {
  await (await setupUser()).click(
    await screen.findByRole("tab", { name: "정보" }),
  );
}

describe("세션 상세 레이아웃", () => {
  test("Radix 탭은 화살표로 선택하고 디버그 토글은 진행 탭에만 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const user = await setupUser();
    const list = await screen.findByRole("tablist", { name: "세션 상세" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["진행", "결과물0", "정보"]);
    await user.click(screen.getByRole("tab", { name: "진행" }));
    // The list wraps, so the last tab is one step left of the first.
    await user.keyboard("{ArrowLeft}");
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "정보" }).getAttribute("aria-selected"),
      ).toBe("true"),
    );
    expect(screen.queryByLabelText("내부 이벤트도 보기")).toBeNull();
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(screen.getByLabelText("내부 이벤트도 보기")).toBeTruthy(),
    );
    expect(list.contains(screen.getByLabelText("내부 이벤트도 보기"))).toBe(
      false,
    );
  });

  test.each(["error", "loading"] as const)(
    "pending %s keeps the composer under the timeline",
    async (state) => {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
          state === "loading"
            ? new Promise<Response>(() => {})
            : json(500, {
                error: { code: "INTERNAL_ERROR", message: "pending failed" },
              }),
      });
      const composer = await screen.findByRole("textbox", {
        name: "다음 지시",
      });
      expect(composer.closest('[role="tabpanel"]')).toBeTruthy();
      const aside = screen.getByRole("complementary", { name: "답변과 승인" });
      if (state === "error")
        await within(aside).findByRole("button", { name: "다시 시도" });
      else expect(within(aside).getByText("불러오는 중…")).toBeTruthy();
      expect(
        screen.getAllByRole("textbox", { name: "다음 지시" }),
      ).toHaveLength(1);
      // Requests that could not be read are not reported as none.
      expect(aside.textContent).not.toContain("기다리는 요청 없음");
      expect(aside.textContent).not.toContain(
        "답변 대기 · 요청이 오면 여기에 먼저 나옵니다.",
      );
    },
  );

  test("헤더는 세션 목록 뒤에 이름 붙은 제어 아이콘을, 메타 줄에 저장소·모델·사용량을 둔다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const pause = await screen.findByRole("button", { name: "일시 정지" });
    const header = pause.closest("header") as HTMLElement;
    expect(pause.getAttribute("title")).toBe("일시 정지");
    expect(pause.textContent).toBe("");
    const back = within(header).getByRole("link", { name: "세션 목록" });
    // The keyboard reaches the way back before the commands.
    expect(
      back.compareDocumentPosition(pause) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(header).getByRole("button", { name: "세션 종료" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "답변 대기",
    );
    expect(header.textContent).toContain("demo");
    expect(header.textContent).toContain("model-default");
    await waitFor(() => expect(header.textContent).toContain("$0.4200"));

    const panel = screen.getByRole("complementary", { name: "답변과 승인" });
    expect(within(panel).getByText("답할 수 있는 사람")).toBeTruthy();
    expect(
      await within(panel).findByText("나는 이 세션의 요청에 답할 수 있습니다."),
    ).toBeTruthy();
    // The session's API carries no agent, starter or branch yet.
    expect(header.textContent).toContain("에이전트 정보 없음");
    expect(header.textContent).toContain("시작한 사람·경로 정보 없음");
    await setupInfo();
    expect(screen.getAllByText("아직 볼 수 없습니다")).toHaveLength(3);
  });

  test.each([
    ["hello.txt 만들고 commit", "hello.txt 만들고 commit"],
    [null, SESSION_ID.slice(0, 8)],
  ])("제목 %p는 머리에 %p로 쓴다", async (title, shown) => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () => json(200, { ...detail, title }),
    });
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent?.startsWith(`${shown}작업 상태: `)).toBe(true);
  });

  test("ID 복사는 세션 ID 전체를 복사하고 그렇다고 알린다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const user = await setupUser();
    // After setupUser, which installs a clipboard of its own.
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    try {
      await user.click(
        await screen.findByRole("button", { name: "세션 ID 복사" }),
      );
      expect(copied).toEqual([SESSION_ID]);
      expect(await screen.findByText("세션 ID를 복사했습니다.")).toBeTruthy();
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("공유받아 보기만 하는 사람에게는 답할 수 없다고 말한다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
        json(200, { ...pending, answerable: false }),
    });
    const panel = await screen.findByRole("complementary", {
      name: "답변과 승인",
    });
    expect(
      await within(panel).findByText(
        "공유받아 볼 수만 있어 요청에 답할 수 없습니다.",
      ),
    ).toBeTruthy();
  });

  test("작성 중인 다음 지시는 요청이 생기고 사라져도, 폭이 바뀌어도 남는다", async () => {
    const original = globalThis.ResizeObserver;
    let resize: ResizeObserverCallback | undefined;
    class Observer {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
    try {
      const user = await setupUser();
      let open: ListPendingRequestsResponse["items"] = [];
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
          json(200, { answerable: true, items: open }),
        [`POST /v1/sessions/${SESSION_ID}/answers`]: () => {
          open = [];
          return json(202, {
            receipt_id: RECEIPT_ID,
            receipt_status: "accepted",
          });
        },
      });
      const draft = () =>
        (
          screen.getByRole("textbox", {
            name: "다음 지시",
          }) as HTMLTextAreaElement
        ).value;
      await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.");
      await user.click(screen.getByRole("textbox", { name: "다음 지시" }));
      await user.keyboard("next step draft");
      await waitFor(() => expect(stream.requests).toHaveLength(1));
      await act(async () => stream.open());

      open = pending.items.map((item) => ({ ...item, expires_at: LATER }));
      act(() => stream.emit("ev_1", "status", { phase: "running" }));
      const allow = await screen.findByRole("button", { name: "허용" });
      expect(draft()).toBe("next step draft");

      await waitFor(() => expect(resize).toBeDefined());
      act(() =>
        resize?.(
          [{ contentRect: { width: 390 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
      expect(draft()).toBe("next step draft");

      allow.focus();
      await user.keyboard("{Enter}");
      await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.");
      expect(draft()).toBe("next step draft");

      act(() =>
        resize?.(
          [{ contentRect: { width: 1000 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
      expect(draft()).toBe("next step draft");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  test("다른 세션으로 옮기면 앞 세션의 초안을 가져가지 않는다", async () => {
    const user = await setupUser();
    const { history } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${OTHER_ID}`]: () =>
        json(200, { ...detail, id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/usage`]: () =>
        json(200, { ...usage, session_id: OTHER_ID }),
      [`GET /v1/sessions/${OTHER_ID}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
      [`GET /v1/sessions/${OTHER_ID}/events`]: () =>
        new Promise<Response>(() => {}),
    });
    await screen.findByText("권한 요청: Bash");
    await user.click(screen.getByRole("textbox", { name: "다음 지시" }));
    await user.keyboard("for the first session");
    expect(
      (
        screen.getByRole("textbox", {
          name: "다음 지시",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("for the first session");
    act(() => history.push(`/sessions/${OTHER_ID}`));
    await screen.findByRole("heading", {
      name: new RegExp(`^${OTHER_ID.slice(0, 8)}`),
    });
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "다음 지시",
        })) as HTMLTextAreaElement
      ).value,
    ).toBe("");
  });

  test("작성창은 늘 진행 탭의 타임라인 아래에 있고 넓은 화면은 본문부터 읽는다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    await screen.findByRole("textbox", { name: "다음 지시" });
    await waitFor(() =>
      expect(
        screen
          .getByRole("textbox", { name: "다음 지시" })
          .closest('[role="tabpanel"]'),
      ).toBeTruthy(),
    );
    const layout = document.querySelector(
      '[data-slot="session-detail-layout"]',
    );
    expect(layout?.firstElementChild?.getAttribute("data-slot")).toBe("tabs");
    expect(layout?.lastElementChild?.tagName).toBe("ASIDE");
  });

  test("900px 미만은 패널부터 읽고, 요청이 없어도 작성창은 본문에 있다", async () => {
    const original = globalThis.ResizeObserver;
    let resize: ResizeObserverCallback | undefined;
    class Observer {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
    try {
      renderAt(`/sessions/${SESSION_ID}`, {
        ...detailRoutes,
        [`GET /v1/sessions/${SESSION_ID}/pending-requests`]: () =>
          json(200, { answerable: true, items: [] }),
      });
      await screen.findByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.");
      const composer = screen.getByRole("textbox", { name: "다음 지시" });
      expect(composer.closest("aside")).toBeNull();
      expect(composer.closest('[role="tabpanel"]')).toBeTruthy();
      expect(
        screen.getAllByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다."),
      ).toHaveLength(1);
      expect(
        screen
          .getByText("답변 대기 · 요청이 오면 여기에 먼저 나옵니다.")
          .closest("section")?.textContent,
      ).toContain("기다리는 요청 없음");
      await waitFor(() => expect(resize).toBeDefined());
      act(() =>
        resize?.(
          [{ contentRect: { width: 390 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
      const layout = document.querySelector(
        '[data-slot="session-detail-layout"]',
      );
      expect(layout?.firstElementChild?.tagName).toBe("ASIDE");
      expect(layout?.lastElementChild?.getAttribute("data-slot")).toBe("tabs");
      act(() =>
        resize?.(
          [{ contentRect: { width: 1000 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
      expect(layout?.firstElementChild?.getAttribute("data-slot")).toBe("tabs");
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe("세션 상세 머리 경로", () => {
  const trail = async () => {
    const [header] = await screen.findAllByRole("banner");
    return within(header as HTMLElement);
  };

  test("세션 목록으로 가는 링크 다음에 세션 제목이 온다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, title: "결제 오류 고치기" }),
    });
    const bar = await trail();
    expect(await bar.findByText("결제 오류 고치기")).toBeTruthy();
    expect(bar.getByRole("link", { name: "세션" }).getAttribute("href")).toBe(
      "/sessions",
    );
  });

  test("주소 끝에 /가 붙어도 세션 제목을 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}/`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        json(200, { ...detail, title: "결제 오류 고치기" }),
    });
    const bar = await trail();
    expect(await bar.findByText("결제 오류 고치기")).toBeTruthy();
  });

  test("제목이 없으면 머리글처럼 짧은 id를 보인다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, detailRoutes);
    const bar = await trail();
    expect(await bar.findByText(SESSION_ID.slice(0, 8))).toBeTruthy();
  });

  test("열어 둔 세션을 다시 불러오다 실패하면 예전 제목을 지운다", async () => {
    let visible = true;
    const { services } = renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        visible
          ? json(200, { ...detail, title: "결제 오류 고치기" })
          : apiError(404, "NOT_FOUND", "Resource not found"),
    });
    const bar = await trail();
    expect(await bar.findByText("결제 오류 고치기")).toBeTruthy();

    visible = false;
    await act(() =>
      services.queryClient.refetchQueries({
        queryKey: ["sessions", SESSION_ID],
        exact: true,
      }),
    );
    expect(await screen.findByText(/이 세션을 찾을 수 없습니다/)).toBeTruthy();
    expect(bar.queryByText("결제 오류 고치기")).toBeNull();
    expect(bar.queryByRole("link")).toBeNull();
  });

  test("세션을 불러오지 못하면 빈 이름 앞에 구분선을 남기지 않고 항목 이름만 둔다", async () => {
    renderAt(`/sessions/${SESSION_ID}`, {
      ...detailRoutes,
      [`GET /v1/sessions/${SESSION_ID}`]: () =>
        apiError(404, "NOT_FOUND", "no such session"),
    });
    expect(await screen.findByText(/이 세션을 찾을 수 없습니다/)).toBeTruthy();
    const bar = await trail();
    expect(bar.queryByRole("link")).toBeNull();
    expect(bar.getByText("세션")).toBeTruthy();
    expect(bar.queryByText("/")).toBeNull();
  });
});

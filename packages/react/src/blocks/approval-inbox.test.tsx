import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ApiClientOptions, createApiClient } from "@werft-ai/client";
import type { PendingRequest } from "@werft-ai/contracts";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { ReactNode } from "react";
import type { ApprovalLayout } from "./session-actions.tsx";

const { render, waitFor, act } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { AgentPlatformProvider } = await import("../provider.tsx");
const { ApprovalInbox } = await import("./approval-inbox.tsx");
const { PendingAnswers } = await import("./session-actions.tsx");
type ApprovalInboxProps = import("./approval-inbox.tsx").ApprovalInboxProps;

const SESSION_ID = "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SHORT = SESSION_ID.slice(0, 8);
const STALE_ID = "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b02";
const LATER = "2099-01-01T00:00:00.000Z";

const permission = (request_id: string, tool: string): PendingRequest => ({
  request_id,
  turn_id: "1",
  attempt_id: "att_1",
  kind: "permission",
  tool,
  input: { command: "ls" },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: LATER,
});

const QUESTION: PendingRequest = {
  request_id: "req_q",
  turn_id: "1",
  attempt_id: "att_1",
  kind: "question",
  questions: [
    {
      question_id: "q1",
      prompt: "Which branch?",
      options: [{ option_id: "dev", label: "dev" }],
      allow_free_text: false,
      multi_select: false,
    },
  ],
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: LATER,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Posted {
  readonly path: string;
  readonly body: unknown;
}

/**
 * One waiting session whose open requests are `open`; an answer removes the
 * request it answers, as the server does.
 */
function renderInbox({
  open,
  layout,
  unavailable,
  answerable = true,
  title = null,
  extra,
  body,
  stale = false,
  hold = false,
  events = [],
}: {
  open: PendingRequest[];
  layout?: ApprovalLayout;
  unavailable?: { answer?: string };
  answerable?: boolean;
  title?: string | null;
  extra?: Partial<ApprovalInboxProps>;
  /** Drawn in place of the inbox, inside the same providers. */
  body?: ReactNode;
  /** The waiting list also names STALE_ID, whose own list is empty. */
  stale?: boolean;
  /** Answers never come back, as a slow server's. */
  hold?: boolean;
  /** The session's event stream, held open after these frames. */
  events?: (readonly [event: string, data: unknown])[];
}) {
  const posted: Posted[] = [];
  let waitingReads = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let sequence = 0;
  const frame = ([event, data]: readonly [string, unknown]) => {
    sequence += 1;
    return `id: ev_${sequence}\nevent: ${event}\ndata: ${JSON.stringify({
      schema_version: 1,
      session_id: SESSION_ID,
      turn_id: "1",
      attempt_id: null,
      occurred_at: "2026-10-21T00:59:00.000Z",
      data,
    })}\n\n`;
  };
  let items = open;
  const fakeFetch = async (request: Request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}${url.search}`;
    if (route === "GET /v1/sessions?status=needs_input") {
      waitingReads += 1;
      return json(200, {
        items: [
          ...(items.length
            ? [{ id: SESSION_ID, title, status: "needs_input" }]
            : []),
          ...(stale
            ? [{ id: STALE_ID, title: null, status: "needs_input" }]
            : []),
        ],
        next_cursor: null,
      });
    }
    if (route === `GET /v1/sessions/${STALE_ID}/pending-requests`) {
      return json(200, { answerable: true, items: [] });
    }
    if (route === `GET /v1/sessions/${SESSION_ID}/pending-requests`) {
      return json(200, { answerable, items });
    }
    if (url.pathname === `/v1/sessions/${SESSION_ID}/events`) {
      const frames = events.map(frame).join("");
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          stream = controller;
          controller.enqueue(new TextEncoder().encode(frames));
          request.signal.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (route === `POST /v1/sessions/${SESSION_ID}/answers`) {
      const body = JSON.parse(await request.text()) as {
        request_id: string;
      };
      posted.push({ path: url.pathname, body });
      if (hold) return new Promise<Response>(() => {});
      items = items.filter((item) => item.request_id !== body.request_id);
      return json(202, { receipt_id: "rcpt_1", receipt_status: "accepted" });
    }
    return json(404, { error: { code: "NOT_FOUND", message: route } });
  };
  const client = createApiClient({
    baseUrl: "https://console.test",
    fetch: fakeFetch as unknown as NonNullable<ApiClientOptions["fetch"]>,
  });
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <AgentPlatformProvider
        client={client}
        locale="en"
        renderLink={({ id, children, className, ...rest }) => (
          <a href={`/sessions/${id}`} className={className} {...rest}>
            {children}
          </a>
        )}
      >
        {body ?? (
          <ApprovalInbox
            loading={<p>loading</p>}
            renderError={() => <p>failed</p>}
            layout={layout}
            unavailable={unavailable}
            {...extra}
          />
        )}
      </AgentPlatformProvider>
    </QueryClientProvider>,
  );
  return {
    ...view,
    posted,
    waitingReads: () => waitingReads,
    /** Sends more frames down the open event stream. */
    push: (...more: (readonly [event: string, data: unknown])[]) =>
      stream?.enqueue(new TextEncoder().encode(more.map(frame).join(""))),
  };
}

describe("ApprovalInbox", () => {
  test("기본은 지금처럼 카드로 그린다", async () => {
    const view = renderInbox({ open: [permission("req_1", "Bash")] });
    const { container } = view;
    await view.findByText("Permission request: Bash");
    expect(container.querySelector("[data-slot='approval-card']")).toBeTruthy();
    expect(container.querySelector("[data-slot='approval-row']")).toBeNull();
    // The card keeps its plain button names.
    expect(view.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  test("행 배치는 권한 요청을 한 줄로, 질문은 카드 그대로 그린다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash"), QUESTION],
      layout: "row",
    });
    const { container } = view;
    await view.findByText("Permission request: Bash");
    expect(container.querySelector("[data-slot='approval-card']")).toBeNull();
    const row = container.querySelector("[data-slot='approval-row']");
    expect(row?.closest("li")).toBeTruthy();
    expect(row?.tagName).toBe("ARTICLE");
    expect(container.querySelector("[data-slot='question-card']")).toBeTruthy();
    // The session link rides on the row's line.
    expect(
      row?.querySelector(`a[aria-label="Open session ${SESSION_ID}"]`),
    ).toBeTruthy();
  });

  test("행에서 허용하면 카드와 같은 답을 보내고, 키보드는 다음 행으로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash"), permission("req_2", "Write")],
      layout: "row",
    });
    const { posted } = view;
    const allow = await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    });
    allow.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(view.queryByText("Permission request: Bash")).toBeNull(),
    );
    expect(posted).toEqual([
      {
        path: `/v1/sessions/${SESSION_ID}/answers`,
        body: { request_id: "req_1", kind: "permission", decision: "allow" },
      },
    ]);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        `Allow: Write · ${SHORT}`,
      ),
    );
  });

  test("행에서 거부하면 적은 이유를 함께 보낸다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "row",
    });
    const { posted } = view;
    await user.click(
      await view.findByRole("button", { name: `Deny: Bash · ${SHORT}` }),
    );
    await user.keyboard("not now");
    await user.click(view.getByRole("button", { name: "Send denial" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "deny",
      reason: "not now",
    });
  });

  test("답할 수 없는 사람에게는 행의 버튼이 막히고 이유가 보인다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "row",
      unavailable: { answer: "needs sessions:approve" },
    });
    const allow = (await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    })) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    expect(view.getByText("needs sessions:approve")).toBeTruthy();
  });
  test("요약 배치는 세션 이름 아래 요청을 한 줄로 두고, 답은 그 자리에서 보낸다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash"), QUESTION],
      layout: "summary",
      title: "Fix README",
      extra: {
        title: "Requests waiting on you",
        action: <a href="/sessions?status=needs_input">View all</a>,
        now: Date.parse("2026-10-21T01:02:30.000Z"),
      },
    });
    const { container, posted } = view;
    await view.findByText("Permission request: Bash");
    expect(view.getByRole("heading", { level: 2 }).textContent).toBe(
      "Requests waiting on you",
    );
    expect(view.getByRole("link", { name: "View all" })).toBeTruthy();
    const row = container.querySelector("[data-slot='approval-row']");
    // One frame for the list; the line itself carries no card of its own.
    expect(row?.className).not.toContain("rounded-card");
    expect(
      row?.closest("ul")?.parentElement?.closest("ul")?.className,
    ).toContain("rounded-card");
    const name = view.getAllByRole("link", {
      name: "Open session Fix README",
    });
    expect(name[0]?.textContent).toBe("Fix README");
    expect(row?.textContent).toContain(`${SHORT} · Waiting 3 min`);
    // The question keeps its card, under a line of the same shape.
    expect(container.querySelector("[data-slot='question-card']")).toBeTruthy();
    expect(name).toHaveLength(2);
    await user.click(
      view.getByRole("button", { name: `Allow: Bash · ${SHORT}` }),
    );
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({
      request_id: "req_1",
      kind: "permission",
      decision: "allow",
    });
  });

  test("요청이 이미 닫힌 세션은 줄도 수도 없이 빠지고, 대기 목록을 다시 읽는다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      stale: true,
    });
    await view.findByText("Permission request: Bash");
    await waitFor(() => expect(view.waitingReads()).toBeGreaterThanOrEqual(2));
    expect(view.queryByText("Nothing is waiting for an answer.")).toBeNull();
    expect(
      view.queryByRole("link", { name: `Open session ${STALE_ID}` }),
    ).toBeNull();
    expect(view.container.querySelectorAll("section > ul > li")).toHaveLength(
      1,
    );
    expect(view.getByText("1 sessions waiting for an answer")).toBeTruthy();
  });

  test("요약 배치의 질문은 한 줄로 접혀 있고, 답하기로 펼치면 첫 선택지로 간다", async () => {
    const user = await setupUser();
    const view = renderInbox({ open: [QUESTION], layout: "summary" });
    const open = await view.findByRole("button", { name: "Answer" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    // The line says what it asks; the folded form asks it again in full.
    expect(view.getAllByText("Which branch?")[0]?.className).toContain(
      "truncate",
    );
    const form = document.getElementById(
      open.getAttribute("aria-controls") ?? "",
    );
    expect(form?.hidden).toBe(true);
    await user.click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(form?.hidden).toBe(false);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("role")).toBe("radio"),
    );
    await user.keyboard(" ");
    await user.click(view.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]?.body).toEqual({
      request_id: "req_q",
      kind: "question",
      answers: [{ question_id: "q1", selected_option_ids: ["dev"] }],
    });
  });

  test("답이 가는 동안 누른 버튼이 돌고 줄은 aria-busy, 두 번 눌러도 한 번만 보낸다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      hold: true,
    });
    const allow = await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    });
    await user.click(allow);
    await waitFor(() => expect(allow.hasAttribute("disabled")).toBe(true));
    expect(allow.querySelector("[data-slot='busy']")).not.toBeNull();
    expect(allow.closest("[aria-busy='true']")).not.toBeNull();
    await user.click(allow);
    expect(view.posted).toHaveLength(1);
  });

  test("요약 배치에서 제목이 없는 세션은 짧은 ID로 부른다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
    });
    await view.findByText("Permission request: Bash");
    const link = view.getByRole("link", {
      name: `Open session ${SESSION_ID}`,
    });
    expect(link.textContent).toBe(SHORT);
    const row = view.container.querySelector("[data-slot='approval-row']");
    expect(row?.textContent?.split(SHORT)).toHaveLength(2);
  });

  test("요약 배치에서 답할 수 없으면 이유가 줄 안에 한 번 붙고 버튼은 막힌다", async () => {
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      answerable: false,
    });
    const allow = (await view.findByRole("button", {
      name: `Allow: Bash · ${SHORT}`,
    })) as HTMLButtonElement;
    expect(allow.disabled).toBe(true);
    const row = view.container.querySelector("[data-slot='approval-row']");
    const reason = view.getAllByText(/can answer\./);
    expect(reason).toHaveLength(1);
    expect(row?.contains(reason[0] ?? null)).toBe(true);
  });

  test("기다리는 세션이 없으면 넘겨받은 빈 상태를, 없으면 기본 한 줄을 보인다", async () => {
    const given = renderInbox({
      open: [],
      layout: "summary",
      extra: { empty: <p>nothing to answer</p> },
    });
    await given.findByText("nothing to answer");
    given.unmount();
    const plain = renderInbox({ open: [], layout: "summary" });
    await plain.findByText("No session is waiting for an answer.");
  });
  test("요약 배치를 heading 없이 써도 줄은 세션을 짧은 ID로 부르고 이유를 붙인다", async () => {
    const view = renderInbox({
      open: [],
      body: (
        <PendingAnswers
          sessionId={SESSION_ID}
          items={[permission("req_1", "Bash")]}
          answerable={false}
          layout="summary"
          meta={() => "waited"}
        />
      ),
    });
    const row = await view.findByRole("article");
    expect(row.textContent).toContain(SHORT);
    expect(row.textContent).toContain("waited");
    expect(row.textContent).toContain("can answer.");
  });

  test("now를 넘기지 않은 요약 배치는 분마다 대기 시간을 다시 센다", async () => {
    const start = Date.parse("2026-10-21T01:02:30.000Z");
    setSystemTime(new Date(start));
    const ticks: (() => void)[] = [];
    const interval = spyOn(globalThis, "setInterval").mockImplementation(((
      tick: () => void,
    ) => {
      ticks.push(tick);
      return 0;
    }) as unknown as typeof setInterval);
    try {
      const view = renderInbox({
        open: [permission("req_1", "Bash")],
        layout: "summary",
        title: "Fix README",
      });
      const row = await view.findByRole("article");
      expect(row.textContent).toContain("Waiting 3 min");
      setSystemTime(new Date(start + 2 * 60_000));
      await act(async () => {
        for (const tick of ticks) tick();
      });
      expect(row.textContent).toContain("Waiting 5 min");
    } finally {
      interval.mockRestore();
      setSystemTime();
    }
  });

  test("패널 배치는 줄마다 상세 보기 하나를 두고, 오른쪽 패널의 타임라인 질문 행에서 답한다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [QUESTION],
      layout: "summary",
      title: "Fix README",
      extra: { panel: true },
      events: [
        [
          "question",
          {
            request_id: "req_q",
            tool_use_id: "tu_1",
            kind: "question",
            tool: "AskUserQuestion",
            input: {
              questions: QUESTION.kind === "question" ? QUESTION.questions : [],
            },
          },
        ],
        ["error", { message: "No input for 1802s" }],
      ],
    });
    const opener = await view.findByRole("button", {
      name: "View details of Fix README",
    });
    // The line answers nothing itself.
    expect(view.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(view.getByText("Which branch?").className).toContain("truncate");
    await user.click(opener);
    const panel = await view.findByRole("dialog", { name: "Fix README" });
    // The question's line says what it asks, not the tool's name, and its
    // form sits right under it.
    const timeline = await waitFor(() => {
      const list = panel.querySelector("ol");
      expect(list?.textContent).toContain("Which branch?");
      return list as HTMLOListElement;
    });
    expect(timeline.textContent).not.toContain("AskUserQuestion");
    await waitFor(() =>
      expect(
        timeline.querySelector(
          "[data-kind='request'] [data-slot='question-card']",
        ),
      ).toBeTruthy(),
    );
    expect(timeline.textContent).toContain(
      "Stopped after 30 minutes with no input",
    );
    expect(timeline.querySelector("details")?.textContent).toContain(
      "No input for 1802s",
    );
    await user.click(view.getByRole("radio", { name: "dev" }));
    await user.click(view.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]?.body).toEqual({
      request_id: "req_q",
      kind: "question",
      answers: [{ question_id: "q1", selected_option_ids: ["dev"] }],
    });
    // The panel stays while the session leaves the list behind it.
    await waitFor(() => expect(panel.textContent).toContain("Answer sent."));
    expect(view.getByRole("dialog")).toBe(panel);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    // Its line left with the session: the keyboard goes to the heading.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
  });

  test("패널은 Esc로 닫히면 연 버튼으로 키보드를 돌려준다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [permission("req_1", "Bash")],
      layout: "summary",
      extra: { panel: true },
    });
    const opener = await view.findByRole("button", {
      name: `View details of ${SHORT}`,
    });
    expect(view.getByText("Bash: ls")).toBeTruthy();
    await user.click(opener);
    await view.findByRole("dialog");
    expect(document.activeElement?.closest("[role='dialog']")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement === opener).toBe(true));
  });

  test("패널에서 위에 그린 답 폼은 질문 이벤트가 늦게 와도 옮겨지지 않고 고른 값을 지킨다", async () => {
    const user = await setupUser();
    const view = renderInbox({
      open: [QUESTION],
      layout: "summary",
      extra: { panel: true },
    });
    await user.click(
      await view.findByRole("button", { name: `View details of ${SHORT}` }),
    );
    const panel = await view.findByRole("dialog");
    const radio = await waitFor(() => {
      const found = panel.querySelector<HTMLInputElement>("[role='radio']");
      expect(found).toBeTruthy();
      return found as HTMLInputElement;
    });
    // Drawn above the timeline: the stream has not said where it was asked.
    expect(radio.closest("ol")).toBeNull();
    await user.click(radio);
    expect(radio.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      view.push([
        "question",
        {
          request_id: "req_q",
          tool_use_id: "tu_1",
          kind: "question",
          tool: "AskUserQuestion",
          input: {
            questions: QUESTION.kind === "question" ? QUESTION.questions : [],
          },
        },
      ]);
    });
    await waitFor(() =>
      expect(panel.querySelector("ol")?.textContent).toContain("Which branch?"),
    );
    // The same form, with what was chosen, and no second one in the line.
    expect(panel.querySelectorAll("[role='radio']")).toHaveLength(1);
    expect(radio.isConnected).toBe(true);
    expect(radio.getAttribute("aria-checked")).toBe("true");
  });
});

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ApiClientOptions, createApiClient } from "@werft-ai/client";
import type { PendingRequest } from "@werft-ai/contracts";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import type { ApprovalLayout } from "./session-actions.tsx";

const { render, waitFor } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { AgentPlatformProvider } = await import("../provider.tsx");
const { ApprovalInbox } = await import("./approval-inbox.tsx");
type ApprovalInboxProps = import("./approval-inbox.tsx").ApprovalInboxProps;

const SESSION_ID = "0192f0c4-3d1e-4c7a-9b2f-5e6d7c8a9b01";
const SHORT = SESSION_ID.slice(0, 8);
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
}: {
  open: PendingRequest[];
  layout?: ApprovalLayout;
  unavailable?: { answer?: string };
  answerable?: boolean;
  title?: string | null;
  extra?: Partial<ApprovalInboxProps>;
}) {
  const posted: Posted[] = [];
  let items = open;
  const fakeFetch = async (request: Request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}${url.search}`;
    if (route === "GET /v1/sessions?status=needs_input") {
      return json(200, {
        items: items.length
          ? [{ id: SESSION_ID, title, status: "needs_input" }]
          : [],
        next_cursor: null,
      });
    }
    if (route === `GET /v1/sessions/${SESSION_ID}/pending-requests`) {
      return json(200, { answerable, items });
    }
    if (route === `POST /v1/sessions/${SESSION_ID}/answers`) {
      const body = JSON.parse(await request.text()) as {
        request_id: string;
      };
      posted.push({ path: url.pathname, body });
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
        <ApprovalInbox
          loading={<p>loading</p>}
          renderError={() => <p>failed</p>}
          layout={layout}
          unavailable={unavailable}
          {...extra}
        />
      </AgentPlatformProvider>
    </QueryClientProvider>,
  );
  return { ...view, posted };
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
});

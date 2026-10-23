import { describe, expect, test } from "bun:test";
import {
  presentTurnEvent,
  type SessionSummary,
  type TurnEventMessage,
} from "@werft-ai/contracts";

import { setupDom } from "@werft-ai/ui/test-support/dom";
import type { SessionRowMessages } from "./session-row.tsx";
import type { TimelineEntry, TimelineMessages } from "./timeline.tsx";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists.
const { SESSION_COLUMNS, SessionRow } = await import("./session-row.tsx");
const { StageIndicator } = await import("./stage-indicator.tsx");
const { Timeline } = await import("./timeline.tsx");

test("세션 표 열 정의는 폭마다 떨어진 class 하나씩이다", () => {
  // Two classes run together are one unknown class, and Tailwind drops both.
  expect(SESSION_COLUMNS.split(" ")).toEqual([
    "grid",
    expect.stringMatching(/^grid-cols-\[[^\s@]+\]$/),
    expect.stringMatching(/^@\[480px\]:grid-cols-\[[^\s@]+\]$/),
    expect.stringMatching(/^@\[820px\]:grid-cols-\[[^\s@]+\]$/),
  ]);
});

// Echoes the key and params, so a test reads what the component asked for.
function formatMessage({ key, params }: TurnEventMessage): string {
  return params ? `${key}${JSON.stringify(params)}` : key;
}

const MESSAGES: TimelineMessages = {
  label: "events",
  empty: "no events",
  connecting: "connecting",
  closed: "closed",
  turn: (turnId) => `turn ${turnId}`,
};

let sequence = 0;
function entry(
  event: string,
  data: unknown,
  turnId: string | null = "t1",
): TimelineEntry {
  sequence += 1;
  return {
    id: `e${sequence}`,
    occurredAt: "2026-10-21T01:00:00.000Z",
    turnId,
    presentation: presentTurnEvent({ event, data }),
  };
}

const tick = (turnId = "t1") =>
  entry("system", { subtype: "thinking_tokens" }, turnId);

function summaries() {
  return [...document.querySelectorAll("li")].map(
    (item) => item.textContent ?? "",
  );
}

describe("Timeline", () => {
  test("한 turn 안에 이어진 thinking tick은 한 줄로 접히고 개수를 센다", () => {
    render(
      <Timeline
        entries={[tick(), tick(), tick(), tick("t2")]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    const lines = summaries();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('session.event.thinkingTokens{"count":3}');
    expect(lines[1]).toContain('session.event.thinkingTokens{"count":1}');
  });

  test("응답·도구·요청·오류·시스템 이벤트는 아이콘이 다르고 아이콘마다 이름이 있다", () => {
    const { container } = render(
      <Timeline
        entries={[
          entry("assistant", {
            message: { content: [{ type: "text", text: "hi" }] },
          }),
          entry("tool_use", {
            message: {
              content: [{ type: "tool_use", id: "c1", name: "Bash" }],
            },
          }),
          entry("question", { kind: "permission", tool: "Bash", input: {} }),
          entry("error", { message: "boom" }),
          entry("status", { phase: "running" }),
        ]}
        formatMessage={formatMessage}
        messages={{ ...MESSAGES, kind: (kind) => `kind:${kind}` }}
      />,
    );
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.dataset.kind)).toEqual([
      "agent",
      "tool",
      "request",
      "error",
      "system",
    ]);
    const icons = rows.map((row) => row.querySelector('[role="img"]'));
    expect(icons.map((icon) => icon?.getAttribute("aria-label"))).toEqual([
      "kind:agent",
      "kind:tool",
      "kind:request",
      "kind:error",
      "kind:system",
    ]);
    const drawn = icons.map((icon) => icon?.querySelector("svg")?.innerHTML);
    expect(new Set(drawn).size).toBe(5);
  });

  test("아이콘 이름을 주지 않으면 아이콘은 스크린리더에서 숨는다", () => {
    const { container } = render(
      <Timeline
        entries={[entry("error", { message: "boom" })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelector('li [aria-hidden="true"]')).not.toBeNull();
  });

  test("debug 이벤트는 showDebug일 때만 보이고 tick 접기를 끊지 않는다", () => {
    const entries = [
      tick(),
      entry("system", { subtype: "sdk_event", native_type: "rate_limit" }),
      tick(),
    ];
    const { rerender } = render(
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toContain('{"count":2}');
    rerender(
      <Timeline
        entries={entries}
        formatMessage={formatMessage}
        messages={MESSAGES}
        showDebug
      />,
    );
    expect(summaries().some((line) => line.includes("rate_limit"))).toBe(true);
  });

  test("말할 것이 없는 이벤트는 빈 줄을 만들지 않는다", () => {
    render(
      <Timeline
        entries={[
          entry("assistant", { message: { content: [] } }),
          entry("system", { subtype: "" }),
          entry("unknown_event", {}),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    expect(summaries()).toEqual([]);
    expect(document.body.textContent).toContain("no events");
  });

  test("짝지은 도구 결과와 오류를 그리고 생각은 접어 둔다", () => {
    const result: TimelineEntry = {
      ...entry("tool_result", { is_error: true, content: "boom\nmore" }),
      presentation: presentTurnEvent(
        { event: "tool_result", data: { is_error: true, content: "boom" } },
        { toolName: "Bash" },
      ),
    };
    render(
      <Timeline
        entries={[
          result,
          entry("assistant", {
            message: { content: [{ type: "thinking", thinking: "plan" }] },
          }),
        ]}
        formatMessage={formatMessage}
        messages={MESSAGES}
      />,
    );
    const [failed, thought] = [...document.querySelectorAll("li")];
    expect(failed?.dataset.error).toBe("true");
    expect(failed?.textContent).toContain(
      'session.event.toolResult{"tool":"Bash"} · session.event.toolResult.error · boom',
    );
    expect(thought?.querySelector("details summary")?.textContent).toBe(
      "session.event.thought",
    );
    expect(thought?.querySelector("details p")?.textContent).toBe("plan");
    expect(thought?.textContent).toContain("turn t1");
  });

  test("연결 중과 끊김은 상태로 알리고 그때는 빈 문구를 보이지 않는다", () => {
    const { getByRole, rerender } = render(
      <Timeline
        entries={[]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        state="connecting"
      />,
    );
    expect(getByRole("status").textContent).toBe("connecting");
    expect(document.body.textContent).not.toContain("no events");
    rerender(
      <Timeline
        entries={[entry("error", { message: "lost" })]}
        formatMessage={formatMessage}
        messages={MESSAGES}
        state="closed"
      />,
    );
    expect(getByRole("status").textContent).toBe("closed");
    expect(getByRole("list", { name: "events" })).toBeTruthy();
  });
});

describe("StageIndicator", () => {
  test("presentTurnEvent의 라벨과 요약을 상태 영역으로 그린다", () => {
    const { getByRole, rerender } = render(
      <StageIndicator
        presentation={presentTurnEvent({
          event: "status",
          data: { phase: "running" },
        })}
        formatMessage={formatMessage}
        emptyLabel="waiting"
        busy
      />,
    );
    const status = getByRole("status");
    expect(status.textContent).toBe(
      "session.event.kind.statussessions.status.running",
    );
    expect(status.dataset.busy).toBe("true");
    rerender(
      <StageIndicator
        presentation={presentTurnEvent({
          event: "error",
          data: { message: "boom" },
        })}
        formatMessage={formatMessage}
        emptyLabel="waiting"
      />,
    );
    expect(getByRole("status").dataset.error).toBe("true");
    rerender(
      <StageIndicator
        presentation={null}
        formatMessage={formatMessage}
        emptyLabel="waiting"
      />,
    );
    expect(getByRole("status").textContent).toBe("waiting");
  });
});

const ROW_MESSAGES: SessionRowMessages = {
  status: (status) => `status:${status}`,
  admission: (state) => `admission:${state}`,
  statusAxis: "work",
  admissionAxis: "session",
  runtime: "runtime",
  lastEvent: "last",
  created: "created",
  queuedTurns: (count) => `queued:${count}`,
  none: "none",
};

const SESSION: SessionSummary = {
  id: "0192f0c4-7d3a-7b4e-9f00-000000000001",
  revision: 3,
  admission_state: "active",
  status: "running",
  runtime: {
    profile_id: "claude-default",
    kind: "claude_agent_sdk",
    version: "1.2.3",
    model: "model-claude-default",
    permission_mode: "default",
  },
  repository_id: null,
  current_turn_id: null,
  queued_turn_count: 2,
  last_event_at: null,
  created_at: "2026-10-21T01:00:00.000Z",
  updated_at: "2026-10-21T01:00:00.000Z",
};

describe("SessionRow", () => {
  test("행 링크가 전체 id로 읽히고 런타임과 대기 작업을 그린다", () => {
    const { getByRole, container } = render(
      <SessionRow
        session={SESSION}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
      />,
    );
    const link = getByRole("link", { name: SESSION.id });
    expect(link.getAttribute("href")).toBe("/sessions/abc");
    expect(link.textContent).toBe(SESSION.id);
    expect(link.closest('[role="cell"]')).toBeTruthy();
    const row = link.closest('[role="row"]');
    expect(row?.querySelectorAll("a")).toHaveLength(1);
    expect(
      Array.from(row?.children ?? []).every(
        (cell) => cell.getAttribute("role") === "cell",
      ),
    ).toBe(true);
    expect(link.className).toContain("after:inset-0");
    expect(link.className).toContain("focus-visible:after:ring-2");
    const text = container.textContent ?? "";
    for (const part of [
      "work: status:running",
      "session: admission:active",
      "queued:2",
      "runtime: claude-default · claude_agent_sdk 1.2.3",
    ]) {
      expect(text).toContain(part);
    }
  });

  test("상태와 admission은 서로 다른 축의 StatusLabel로 그린다", () => {
    const { container } = render(
      <SessionRow
        session={{ ...SESSION, status: "idle", admission_state: "paused" }}
        renderLink={(link) => <a href="/sessions/abc" {...link} />}
        messages={ROW_MESSAGES}
      />,
    );
    const labels = [...container.querySelectorAll(".ap-status")].map(
      (label) => [
        label.getAttribute("data-axis"),
        label.getAttribute("data-tone"),
      ],
    );
    expect(labels).toEqual([
      ["turn", "positive"],
      ["admission", "caution"],
    ]);
  });
});

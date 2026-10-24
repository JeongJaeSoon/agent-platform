import { describe, expect, test } from "bun:test";
import type { ApiClient } from "@werft-ai/client";
import { setupDom, setupUser } from "@werft-ai/ui/test-support/dom";
import { type ReactNode, useState } from "react";

import type { MapNode, MapSession } from "./types.ts";

const { render } = await setupDom();
// After setupDom: these load @werft-ai/ui (see detail-layout.test.tsx).
const { AgentPlatformProvider } = await import("../../provider.tsx");
const { AgentMap, LaneBoard, laneOf, RelationGraph, RelationTree, ToolChips } =
  await import("./index.ts");

const NOW = Date.parse("2026-10-25T01:30:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function session(over: Partial<MapSession> & { id: string }): MapSession {
  return {
    title: `title ${over.id}`,
    agent: "문서 봇",
    status: "running",
    model: "claude-opus-5-5",
    branch: null,
    lastEventAt: ago(1),
    note: "note",
    toolCount: 3,
    errorCount: 0,
    subagentCount: 0,
    ...over,
  };
}

const NODES: readonly MapNode[] = [
  {
    kind: "run",
    id: "own",
    label: null,
    status: "wait",
    edge: "approval",
    tools: [{ id: "t1", name: "Bash", target: "git push", state: "waiting" }],
  },
  {
    kind: "run",
    id: "sub",
    label: "Explore",
    status: "run",
    edge: "delegation",
    tools: [],
  },
  ...(["request", "response", "waiting"] as const).map(
    (edge): MapNode => ({
      kind: "session",
      id: edge,
      agent: "보안 검토 봇",
      title: `peer ${edge}`,
      status: "running",
      edge,
      message: `message ${edge}`,
      at: ago(3),
    }),
  ),
];

function withPlatform(node: ReactNode, locale: "ko" | "en" = "ko") {
  return render(
    <AgentPlatformProvider
      client={{} as ApiClient}
      locale={locale}
      renderLink={({ to, id, children, className }) => (
        <a href={`/${to}/${id}`} className={className}>
          {children}
        </a>
      )}
    >
      {node}
    </AgentPlatformProvider>,
  );
}

describe("laneOf", () => {
  test("a pinned lane wins until the board is tidied", () => {
    const waiting = session({ id: "a", status: "needs_input" });
    expect(laneOf(waiting)).toBe("attention");
    expect(laneOf({ ...waiting, pinnedLane: "running" })).toBe("running");
  });

  test("idle is its own lane and only stopped sessions are done", () => {
    expect(laneOf(session({ id: "a", status: "idle" }))).toBe("idle");
    expect(laneOf(session({ id: "a", status: "failed" }))).toBe("attention");
    expect(laneOf(session({ id: "a", status: "stopped" }))).toBe("done");
  });
});

describe("ToolChips", () => {
  test("each state is said in words, not only in colour", () => {
    const view = withPlatform(
      <ToolChips
        tools={[
          { id: "1", name: "Read", target: "a.ts", state: "ok" },
          { id: "2", name: "Bash", target: "b", state: "error" },
          { id: "3", name: "Grep", target: "c", state: "running" },
          { id: "4", name: "Bash", target: "d", state: "waiting" },
        ]}
        hidden={14}
      />,
    );
    const items = view.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Reada.ts성공",
      "Bashb실패",
      "Grepc실행 중",
      "Bashd승인 대기",
      "+14",
    ]);
  });
});

describe("RelationGraph", () => {
  const graph = () =>
    withPlatform(
      <RelationGraph
        session={session({ id: "s", toolCount: 41 })}
        nodes={NODES}
        now={NOW}
      />,
    );

  test("one edge per row, in row order, each kind told apart by dash or arrow", () => {
    const view = graph();
    const paths = [
      ...view.container.querySelectorAll<SVGPathElement>("path[data-edge]"),
    ];
    expect(paths.map((p) => p.dataset.edge)).toEqual([
      "approval",
      "delegation",
      "request",
      "response",
      "waiting",
    ]);
    const [approval, delegation, request, response, waiting] = paths;
    // One stroke colour each: two utilities would be ordered by the sheet.
    expect(approval?.getAttribute("class")).toContain(
      "stroke-(color:--ap-tone-attention-fg)",
    );
    expect(approval?.getAttribute("class")).not.toContain("border-strong");
    expect(delegation?.getAttribute("class")).toContain("stroke-dasharray:6_5");
    expect(request?.getAttribute("marker-end")).toMatch(/^url\(#/);
    expect(request?.getAttribute("marker-start")).toBeNull();
    expect(response?.getAttribute("marker-start")).toMatch(/^url\(#/);
    expect(response?.getAttribute("marker-end")).toBeNull();
    expect(waiting?.getAttribute("class")).toContain("stroke-dasharray:1_4");
  });

  test("every edge but delegation names itself beside the row; a subagent keeps its Task badge", () => {
    const view = graph();
    for (const word of ["승인 대기", "요청", "응답", "응답 대기", "Task"])
      expect(view.getAllByText(word).length).toBeGreaterThan(0);
    expect(view.queryByText("위임")).toBeNull();
    expect(view.getByText("도구 41 · 하위 1")).toBeTruthy();
  });

  test("the tree keeps the message and approval badges and drops Task", () => {
    const view = withPlatform(
      <RelationTree session={session({ id: "s" })} nodes={NODES} now={NOW} />,
    );
    expect(view.queryByText("Task")).toBeNull();
    expect(view.getByText("응답 대기")).toBeTruthy();
    expect(view.getByText("승인 대기", { ignore: ".sr-only" })).toBeTruthy();
    expect(view.getByText("승인 대기", { selector: ".sr-only" })).toBeTruthy();
    expect(view.getByText("보안 검토 봇 · peer request")).toBeTruthy();
  });
});

describe("LaneBoard", () => {
  const SESSIONS = [
    session({
      id: "a",
      title: "짧게 기다림",
      status: "needs_input",
      pending: { tool: "Bash · a", waitedMinutes: 4 },
    }),
    session({
      id: "b",
      title: "오래 기다림",
      status: "needs_input",
      pending: { tool: "Bash · b", waitedMinutes: 12 },
    }),
    session({ id: "c", title: "도는 중" }),
  ];

  function Board() {
    const [selected, setSelected] = useState<string | null>("c");
    return (
      <LaneBoard
        sessions={SESSIONS}
        doneCount={2}
        selectedId={selected}
        onSelect={setSelected}
        now={NOW}
      />
    );
  }

  test("the strip lists the longest wait first and opens its session", async () => {
    const user = await setupUser();
    const view = withPlatform(<Board />);
    const strip = view.getByRole("region", { name: "내 답변을 기다리는 요청" });
    expect(strip.textContent).toContain("답변 대기 2 · 가장 오래 12분");
    const lines = [...strip.querySelectorAll("li")].map((li) => li.textContent);
    expect(lines[0]).toContain("Bash · b");
    const [first] = view.getAllByRole("button", { name: "보기" });
    if (!first) throw new Error("no 보기");
    await user.click(first);
    const pressed = (name: RegExp) =>
      view.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed(/오래 기다림/)).toBe("true");
    expect(pressed(/도는 중/)).toBe("false");
  });

  test("an empty lane says so instead of disappearing", () => {
    const view = withPlatform(<Board />);
    expect(view.getByRole("region", { name: "대기" }).textContent).toBe(
      "대기0없음",
    );
  });
});

describe("AgentMap", () => {
  test("only the agent-map entry exports it, so other screens' bundles skip the graph", async () => {
    for (const barrel of ["../index.ts", "../../index.ts"]) {
      const source = await Bun.file(new URL(barrel, import.meta.url)).text();
      expect(source).not.toContain("agent-map");
    }
  });

  const selected = { session: session({ id: "s" }), nodes: NODES };

  test("loading keeps the lanes in place and announces once", () => {
    const view = withPlatform(
      <AgentMap
        sessions={[]}
        doneCount={0}
        selected={null}
        onSelect={() => {}}
        loading
      />,
    );
    expect(view.getAllByRole("status")).toHaveLength(1);
    expect(view.getByRole("status").textContent).toBe(
      "에이전트 지도를 읽는 중",
    );
  });

  test("the detail view below md offers the way back", async () => {
    const user = await setupUser();
    let back = 0;
    const view = withPlatform(
      <AgentMap
        sessions={[selected.session]}
        doneCount={0}
        selected={selected}
        onSelect={() => {}}
        view="detail"
        onBack={() => {
          back += 1;
        }}
        now={NOW}
      />,
    );
    await user.click(view.getByRole("button", { name: "← 목록으로" }));
    expect(back).toBe(1);
    expect(
      view
        .getByRole("link", { name: "타임라인에서 전체 보기" })
        .getAttribute("href"),
    ).toBe("/session/s");
  });

  test("a host locale changes the words, not the data", () => {
    const view = withPlatform(
      <AgentMap
        sessions={[selected.session]}
        doneCount={0}
        selected={selected}
        onSelect={() => {}}
        now={NOW}
      />,
      "en",
    );
    expect(view.getAllByText("Awaiting reply").length).toBeGreaterThan(0);
    expect(view.getByText("Recently ended")).toBeTruthy();
  });
});

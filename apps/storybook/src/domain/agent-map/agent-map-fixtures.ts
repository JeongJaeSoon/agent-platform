import type {
  MapNode,
  MapSession,
  MapSessionNode,
} from "@werft-ai/react/agent-map";

/*
 * The agent map design's data (design-sources/agent-map.stories.tsx), split
 * the way the console reads it: the board from the session list, the rows
 * of the selected session from its own event stream.
 */

export const NOW = Date.parse("2026-10-25T01:30:00Z");
export const ago = (minutes: number) =>
  new Date(NOW - minutes * 60_000).toISOString();

export const DONE_COUNT = 12;

export const SESSIONS: readonly MapSession[] = [
  {
    id: "s1",
    title: "결제 웹훅 재시도 로직 정리",
    agent: "백엔드 도우미",
    status: "needs_input",
    model: "claude-opus-5-5",
    branch: "fix/webhook-retry",
    lastEventAt: ago(12),
    note: "git push 전에 승인을 기다리는 중",
    toolCount: 41,
    errorCount: 1,
    subagentCount: 1,
    pending: {
      tool: "Bash · git push origin fix/webhook-retry",
      waitedMinutes: 12,
    },
  },
  {
    id: "s2",
    title: "온보딩 문서 한국어 번역",
    agent: "문서 봇",
    status: "needs_input",
    model: "claude-sonnet-5-5",
    branch: null,
    lastEventAt: ago(4),
    note: "용어집에 없는 단어 3개를 물어봄",
    toolCount: 18,
    errorCount: 0,
    subagentCount: 0,
    pending: {
      tool: "질문 · 'workspace'를 어떻게 옮길까요?",
      waitedMinutes: 4,
    },
  },
  {
    id: "s3",
    title: "대시보드 차트 접근성 점검",
    agent: "웹 UI 리뷰어",
    status: "running",
    model: "claude-opus-5-5",
    branch: "a11y/charts",
    lastEventAt: ago(0.2),
    note: "Explore 하위 에이전트 3개가 차트 컴포넌트를 나눠 읽는 중",
    toolCount: 63,
    errorCount: 2,
    subagentCount: 3,
  },
  {
    id: "s4",
    title: "주간 사용량 리포트 생성",
    agent: "리포트 봇",
    status: "running",
    model: "claude-haiku-5-5",
    branch: null,
    lastEventAt: ago(1),
    note: "사용량 요약 표를 만드는 중",
    toolCount: 9,
    errorCount: 0,
    subagentCount: 0,
  },
  {
    id: "s5",
    title: "Slack 알림 문구 다듬기",
    agent: "문서 봇",
    status: "queued",
    model: "claude-sonnet-5-5",
    branch: null,
    lastEventAt: ago(2),
    note: "작업자 배정을 기다리는 중",
    toolCount: 0,
    errorCount: 0,
    subagentCount: 0,
  },
];

export const NODES: Readonly<Record<string, readonly MapNode[]>> = {
  s1: [
    {
      kind: "run",
      id: "s1-root",
      label: null,
      status: "wait",
      edge: "approval",
      tools: [
        {
          id: "t1",
          name: "Bash",
          target: "git push origin fix/webhook-retry",
          state: "waiting",
        },
        {
          id: "t2",
          name: "Bash",
          target: "bun test apps/billing",
          state: "ok",
        },
        { id: "t3", name: "Edit", target: "retry.ts", state: "ok" },
      ],
      hiddenTools: 22,
    },
    {
      kind: "run",
      id: "s1-review",
      label: "code-reviewer",
      status: "done",
      edge: "delegation",
      tools: [
        { id: "t4", name: "Read", target: "retry.ts", state: "ok" },
        { id: "t5", name: "Grep", target: "maxAttempts", state: "ok" },
      ],
      hiddenTools: 6,
    },
  ],
  s2: [
    {
      kind: "run",
      id: "s2-root",
      label: null,
      status: "wait",
      edge: "delegation",
      tools: [{ id: "t6", name: "Read", target: "glossary.md", state: "ok" }],
    },
  ],
  s3: [
    {
      kind: "run",
      id: "s3-root",
      label: null,
      status: "run",
      edge: "delegation",
      tools: [
        { id: "t7", name: "Task", target: "Explore × 3", state: "running" },
        {
          id: "t8",
          name: "Bash",
          target: "bun run storybook",
          state: "error",
        },
        { id: "t9", name: "Read", target: "chart.tsx", state: "ok" },
      ],
      hiddenTools: 14,
    },
    {
      kind: "run",
      id: "s3-ex1",
      label: "Explore · 막대 차트",
      status: "run",
      edge: "delegation",
      tools: [
        { id: "t10", name: "Grep", target: "aria-label", state: "running" },
        { id: "t11", name: "Read", target: "bar-chart.tsx", state: "ok" },
      ],
      hiddenTools: 9,
    },
    {
      kind: "run",
      id: "s3-ex2",
      label: "Explore · 선 차트",
      status: "done",
      edge: "delegation",
      tools: [
        { id: "t12", name: "Read", target: "line-chart.tsx", state: "ok" },
        { id: "t13", name: "WebFetch", target: "w3.org/WAI/…", state: "error" },
      ],
      hiddenTools: 4,
    },
    {
      kind: "run",
      id: "s3-ex3",
      label: "Explore · 범례",
      status: "run",
      edge: "delegation",
      tools: [
        { id: "t14", name: "Read", target: "legend.tsx", state: "running" },
      ],
    },
  ],
  s4: [
    {
      kind: "run",
      id: "s4-root",
      label: null,
      status: "run",
      edge: "delegation",
      tools: [
        {
          id: "t15",
          name: "Bash",
          target: "bun scripts/usage.ts",
          state: "running",
        },
      ],
    },
  ],
  s5: [
    {
      kind: "run",
      id: "s5-root",
      label: null,
      status: "idle",
      edge: "delegation",
      tools: [],
    },
  ],
};

/**
 * Provisional: an agent-to-agent message in the smallest shape the map
 * needs until the agent-network design review settles the record.
 */
export interface DraftAgentMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: "request" | "response" | "waiting" | "approval";
  readonly status: "open" | "answered";
  readonly createdAt: string;
  readonly respondedAt?: string;
  readonly sessionId: string;
  readonly body: string;
}

const PEERS: Readonly<
  Record<string, Pick<MapSessionNode, "agent" | "title" | "status">>
> = {
  s6: {
    agent: "보안 검토 봇",
    title: "재시도 키 노출 점검",
    status: "running",
  },
  s7: { agent: "문서 봇", title: "웹훅 재시도 안내 갱신", status: "idle" },
  s8: {
    agent: "데이터 도우미",
    title: "실패 웹훅 집계",
    status: "needs_input",
  },
};

export const MESSAGES: readonly DraftAgentMessage[] = [
  {
    id: "m1",
    from: "s1",
    to: "s6",
    kind: "request",
    status: "open",
    createdAt: ago(9),
    sessionId: "s1",
    body: "retry.ts의 서명 키가 로그에 남는지 봐 주세요",
  },
  {
    id: "m2",
    from: "s7",
    to: "s1",
    kind: "response",
    status: "answered",
    createdAt: ago(20),
    respondedAt: ago(7),
    sessionId: "s1",
    body: "재시도 간격 표를 문서에 반영했습니다",
  },
  {
    id: "m3",
    from: "s1",
    to: "s8",
    kind: "waiting",
    status: "open",
    createdAt: ago(5),
    sessionId: "s1",
    body: "지난 7일 실패 웹훅 수를 물어봄 · 답을 기다리는 중",
  },
];

/** The rows a message adds under the selected session's runs. */
export function messageNodes(
  messages: readonly DraftAgentMessage[],
  sessionId: string,
): MapSessionNode[] {
  return messages.flatMap((message) => {
    if (message.sessionId !== sessionId || message.kind === "approval")
      return [];
    const peerId = message.from === sessionId ? message.to : message.from;
    const peer = PEERS[peerId];
    if (!peer) return [];
    return [
      {
        kind: "session",
        id: `${message.id}-${peerId}`,
        ...peer,
        edge: message.kind,
        message: message.body,
        at: message.respondedAt ?? message.createdAt,
      },
    ];
  });
}

export const selectedOf = (id: string) => {
  const session = SESSIONS.find((s) => s.id === id) ?? SESSIONS[0];
  if (!session) throw new Error("no sessions");
  return { session, nodes: NODES[session.id] ?? [] };
};

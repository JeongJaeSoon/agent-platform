import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  AgentMap,
  type MapNode,
  type MapSession,
} from "@werft-ai/react/agent-map";
import { Button, PageHeader } from "@werft-ai/ui";
import { type ReactNode, useState } from "react";

import {
  ago,
  DONE_COUNT,
  MESSAGES,
  messageNodes,
  NODES,
  NOW,
  SESSIONS,
} from "../domain/agent-map/agent-map-fixtures.ts";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * The agent map design (design-sources/agent-map.html §5): a board of
 * status lanes for every session, and for the selected one a relation
 * panel. The page around AgentMap is the screen's own: header, the
 * freshness line and, in the replay, the step buttons.
 */

function AgentMapScreen({
  sessions,
  nodes,
  initialSelected,
  detailOnly = false,
  loading = false,
  toolbar,
}: {
  readonly sessions: readonly MapSession[];
  readonly nodes: Readonly<Record<string, readonly MapNode[]>>;
  readonly initialSelected: string;
  readonly detailOnly?: boolean;
  readonly loading?: boolean;
  readonly toolbar?: ReactNode;
}) {
  const [selectedId, setSelectedId] = useState(initialSelected);
  const session = sessions.find((s) => s.id === selectedId) ?? sessions[0];
  return (
    <ScreenShell current="sessions" crumb={["세션", "에이전트 지도"]}>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="에이전트 지도"
          description="지금 동작 중인 세션, 그 안의 하위 에이전트와 쓴 도구를 봅니다."
        />
        <p className="-mt-3 m-0 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
          목록 갱신 3초 전 · 실시간은 선택한 세션만
        </p>
        {toolbar}
        <AgentMap
          sessions={sessions}
          doneCount={DONE_COUNT}
          selected={
            session ? { session, nodes: nodes[session.id] ?? [] } : null
          }
          onSelect={setSelectedId}
          view={detailOnly ? "detail" : "board"}
          loading={loading}
          now={NOW}
        />
      </div>
    </ScreenShell>
  );
}

/*
 * The replay: each step is one event the console would read, applied the
 * way the design proposes — append, never reorder under the reader; a status
 * change shows in place and the lane move waits for "자리 정리".
 */
const STEPS = [
  "하위 에이전트 생성",
  "도구 실패",
  "승인 요청",
  "답변 후 턴 끝남",
  "자리 정리",
] as const;

function applyStep(step: number, settled: boolean) {
  let sessions: MapSession[] = SESSIONS.map((s) => ({ ...s }));
  const nodes: Record<string, MapNode[]> = Object.fromEntries(
    Object.entries(NODES).map(([id, rows]) => [id, [...rows]]),
  );
  const update = (id: string, change: Partial<MapSession>) => {
    sessions = sessions.map((s) => (s.id === id ? { ...s, ...change } : s));
  };
  const [own] = nodes.s4 ?? [];
  if (step >= 1 && own?.kind === "run") {
    nodes.s4 = [
      own,
      {
        kind: "run",
        id: "s4-sub",
        label: "general-purpose · 표 검증",
        status: step >= 3 ? "done" : "run",
        edge: "delegation",
        tools:
          step >= 2
            ? [
                {
                  id: "t21",
                  name: "Bash",
                  target: "python verify.py",
                  state: "error",
                },
                { id: "t20", name: "Read", target: "usage.csv", state: "ok" },
              ]
            : [
                {
                  id: "t20",
                  name: "Read",
                  target: "usage.csv",
                  state: "running",
                },
              ],
        fresh: step === 1 || step === 2,
      },
    ];
    update("s4", {
      note: "표 검증을 하위 에이전트에 맡김",
      toolCount: step >= 2 ? 12 : 11,
      errorCount: step >= 2 ? 1 : 0,
      subagentCount: 1,
    });
  }
  if (step >= 3 && own?.kind === "run") {
    nodes.s4 = [
      {
        ...own,
        status: "wait",
        edge: "approval",
        fresh: step === 3,
        tools: [
          {
            id: "t22",
            name: "Bash",
            target: "slack-post #ops",
            state: "waiting",
          },
          ...own.tools.map((t) => ({ ...t, state: "ok" as const })),
        ],
      },
      ...(nodes.s4?.slice(1) ?? []),
    ];
    update("s4", {
      status: "needs_input",
      note: "리포트를 #ops에 올리기 전에 승인을 기다리는 중",
      pending: { tool: "Bash · slack-post #ops", waitedMinutes: 0 },
      lastEventAt: ago(0),
      fresh: step === 3,
    });
  }
  if (step >= 4) {
    update("s2", {
      status: "idle",
      note: "번역을 마치고 다음 메시지를 기다림",
      pending: undefined,
      fresh: step === 4,
    });
  }
  if (!settled) {
    if (step >= 3) update("s4", { pinnedLane: "running" });
    if (step >= 4) update("s2", { pinnedLane: "attention" });
  }
  return { sessions, nodes };
}

function DynamicScreen({ initialStep = 0 }: { readonly initialStep?: number }) {
  const [step, setStep] = useState(initialStep);
  const { sessions, nodes } = applyStep(Math.min(step, 4), step >= 5);
  const pendingMoves = sessions.filter((s) => s.pinnedLane).length;
  return (
    <AgentMapScreen
      sessions={sessions}
      nodes={nodes}
      initialSelected="s4"
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-muted-foreground">
            이벤트 재생
          </span>
          {STEPS.map((label, index) => (
            <Button
              key={label}
              type="button"
              size="sm"
              variant={step === index + 1 ? "secondary" : "outline"}
              onClick={() => setStep(index + 1)}
            >
              {index + 1}. {label}
              {index === 4 && pendingMoves > 0 ? ` (${pendingMoves})` : ""}
            </Button>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setStep(0)}
          >
            처음으로
          </Button>
        </div>
      }
    />
  );
}

const meta = {
  title: "Screens/Agent map",
  component: AgentMapScreen,
  parameters: { layout: "fullscreen" },
  args: { sessions: SESSIONS, nodes: NODES, initialSelected: "s3" },
} satisfies Meta<typeof AgentMapScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = { name: "Board + relation" };
export const BoardDark: Story = {
  name: "Board + relation (dark)",
  globals: { theme: "dark" },
};
export const WaitingSelected: Story = {
  name: "Approval selected",
  args: { initialSelected: "s1" },
};
export const MobileBoard: Story = {
  name: "Board (390px)",
  globals: MOBILE,
};
export const MobileDetail: Story = {
  name: "Detail only (390px tree)",
  args: { detailOnly: true },
  globals: MOBILE,
};

/**
 * s1 also messages three sessions, so all four edge kinds show in one panel.
 * The message record is provisional until the agent-network design review
 * settles it.
 */
export const Messages: Story = {
  name: "Messages and approval edges",
  args: {
    initialSelected: "s1",
    nodes: {
      ...NODES,
      s1: [...(NODES.s1 ?? []), ...messageNodes(MESSAGES, "s1")],
    },
  },
};
export const MessagesMobile: Story = {
  ...Messages,
  name: "Messages and approval edges (390px tree)",
  args: { ...Messages.args, detailOnly: true },
  globals: MOBILE,
};

export const Loading: Story = { args: { loading: true } };
export const LoadingMobile: Story = {
  name: "Loading (390px)",
  args: { loading: true },
  globals: MOBILE,
};

export const Dynamic: StoryObj<typeof DynamicScreen> = {
  name: "Dynamic (event replay)",
  render: (args) => <DynamicScreen {...args} />,
  args: { initialStep: 0 },
};

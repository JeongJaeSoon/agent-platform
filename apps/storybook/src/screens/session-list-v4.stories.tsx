import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionStatus, SessionSummary } from "@werft-ai/contracts";
import {
  SessionOverviewRow,
  SessionOverviewTable,
  SessionStatusLabel,
  StatusLabel,
} from "@werft-ai/react/components";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Link,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { Plus, Search } from "lucide-react";
import { useState } from "react";

import { MOBILE, PartRequest, ScreenShell } from "./screen-kit.tsx";

/*
 * Console v4 session list (Console.dc.html, SESSIONS): one segmented status
 * filter, a search box over the loaded rows, and the title-first table. Rows
 * carry only SessionSummary fields and the oldest pending request's wait.
 * Columns the API cannot fill yet (agent, who started it) are left out, not
 * shown empty. The real screen keeps its one-line approval inbox above the
 * table (Blocks/ApprovalInbox › Rows); this board draws the list alone.
 */

interface Row {
  readonly summary: SessionSummary;
  /** From the oldest pending request's created_at. */
  readonly waitedMinutes?: number;
  /** last_event_at as RelativeTime will show it, and its tooltip. */
  readonly recent: string;
  readonly exact: string;
}

function summary(
  id: string,
  title: string | null,
  status: SessionStatus,
  model: string | null,
  repository: string | null,
  at: string,
): SessionSummary {
  return {
    id,
    title,
    revision: 1,
    admission_state: "active",
    status,
    runtime: model
      ? {
          kind: "claude_agent_sdk",
          version: "1.0.0",
          profile_id: "default",
          model,
          permission_mode: "default",
        }
      : null,
    repository_id: repository,
    current_turn_id: null,
    queued_turn_count: 0,
    last_event_at: at,
    created_at: at,
    updated_at: at,
  };
}

const ROWS: readonly Row[] = [
  {
    summary: summary(
      "c7331e51-0b6c-4a51-9d6e-1f3b2a0c9d01",
      "hello.txt 만들고 commit",
      "needs_input",
      "gpt-5-codex",
      "demo-repo",
      "2026-10-24T06:02:11.000Z",
    ),
    waitedMinutes: 12,
    recent: "12분 전",
    exact: "2026년 10월 24일 15:02:11 GMT+9",
  },
  {
    summary: summary(
      "5e065b90-7c1d-4e8f-8a2b-3c4d5e6f7a02",
      "주간 회의록 결정 사항 정리",
      "running",
      "claude-sonnet-5",
      null,
      "2026-10-24T06:11:40.000Z",
    ),
    recent: "3분 전",
    exact: "2026년 10월 24일 15:11:40 GMT+9",
  },
  {
    summary: summary(
      "e6bfb003-1a2b-4c3d-9e4f-5a6b7c8d9e03",
      "경쟁 제품 문서 비교표",
      "idle",
      "claude-opus-5",
      null,
      "2026-10-23T06:14:02.000Z",
    ),
    recent: "어제 15:14",
    exact: "2026년 10월 23일 15:14:02 GMT+9",
  },
  {
    summary: summary(
      "6e4d1a1f-2b3c-4d5e-8f6a-7b8c9d0e1f04",
      "api6.txt 쓰고 push",
      "stopped",
      "claude-sonnet-5",
      "demo-repo",
      "2026-10-20T00:40:17.000Z",
    ),
    recent: "10/20",
    exact: "2026년 10월 20일 09:40:17 GMT+9",
  },
  {
    // Created before titles existed (migration 0155 backfills none).
    summary: summary(
      "745ce025-4490-4e23-9c22-73671aa69ede",
      null,
      "failed",
      null,
      "demo-repo",
      "2026-10-18T02:03:55.000Z",
    ),
    recent: "10/18",
    exact: "2026년 10월 18일 11:03:55 GMT+9",
  },
];

const FILTERS: readonly (readonly [SessionStatus | "all", string])[] = [
  ["all", "전체"],
  ["needs_input", "답변 대기"],
  ["running", "작업 중"],
  ["idle", "쉬는 중"],
  ["stopped", "멈춤"],
  ["failed", "실패"],
];

const statusWord = (status: SessionStatus) =>
  FILTERS.find(([key]) => key === status)?.[1] ?? status;

const SEGMENT =
  "h-7 flex-none rounded-control border-0 px-2 text-control text-muted-foreground hover:text-foreground data-[state=active]:bg-sidebar-accent data-[state=active]:text-foreground data-[state=active]:shadow-none";

const ROW_MESSAGES = {
  status: statusWord,
  statusAxis: "작업 상태",
  noRepository: "저장소 없음",
  unknown: "—",
  recent: "최근",
};

const HEAD = {
  session: "세션",
  status: "상태",
  model: "모델",
  repository: "저장소",
  recent: "최근",
};

type State = "ready" | "loading" | "empty" | "error";

function SessionListV4Body({
  state,
  initialQuery = "",
}: {
  readonly state: State;
  readonly initialQuery?: string;
}) {
  const [tab, setTab] = useState("all");
  const [query, setQuery] = useState(initialQuery);
  const q = query.trim().toLowerCase();
  const shown = ROWS.filter(
    ({ summary: session }) =>
      (tab === "all" || session.status === tab) &&
      (q === "" ||
        (session.title?.toLowerCase().includes(q) ?? false) ||
        session.id.startsWith(q)),
  );
  return (
    <div className="flex flex-col">
      <PageHeader
        title="세션"
        description="내가 만들었거나 나에게 공유된 세션입니다. 세션을 누르면 상태와 이벤트를 봅니다."
        actions={
          <Button type="button">
            <Plus aria-hidden="true" />새 세션
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <PartRequest name="SegmentedControl" />
          <PartRequest name="RelativeTime + Tooltip" />
          <Badge variant="red">
            탭 개수·에이전트·시작한 사람 열: API 변경 필요 (94S-811)
          </Badge>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <TabsList
              aria-label="상태로 보기"
              className="h-auto max-w-full flex-nowrap justify-start gap-0.5 overflow-x-auto overflow-y-hidden rounded-[8px] border bg-card p-0.5"
            >
              {FILTERS.map(([key, label]) => (
                <TabsTrigger key={key} value={key} className={SEGMENT}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="relative min-w-[140px] max-w-[320px] flex-[1_1_160px]">
              <Search
                className="pointer-events-none absolute top-2 left-2.5 size-4 text-subtle-foreground"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label="제목이나 ID로 찾기"
                placeholder="제목이나 ID로 찾기"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <TabsContent value={tab}>
            {state === "loading" ? (
              <div className="flex flex-col gap-3" aria-busy="true">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : state === "error" ? (
              <ErrorState
                title="세션 목록을 불러오지 못했습니다"
                guidance="연결이 끊겼거나 서버가 응답하지 않습니다. 다시 시도해 주세요."
                code="BACKEND_UNAVAILABLE"
                retry={() => {}}
                retryLabel="다시 시도"
              />
            ) : state === "empty" ? (
              <EmptyState title="아직 세션이 없습니다." />
            ) : shown.length === 0 ? (
              <EmptyState
                title="조건에 맞는 세션이 없습니다"
                description="필터나 검색어를 바꿔 보세요."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setQuery("");
                      setTab("all");
                    }}
                  >
                    필터 지우기
                  </Button>
                }
              />
            ) : (
              <SessionOverviewTable label="세션 표" messages={HEAD}>
                {shown.map((row) => (
                  <SessionOverviewRow
                    key={row.summary.id}
                    session={row.summary}
                    messages={ROW_MESSAGES}
                    statusDetail={
                      row.waitedMinutes === undefined
                        ? undefined
                        : `${row.waitedMinutes}분`
                    }
                    renderTime={(at) => (
                      <time dateTime={at} title={row.exact}>
                        {row.recent}
                      </time>
                    )}
                    renderLink={(link) => (
                      <Link href={`#/sessions/${row.summary.id}`} {...link} />
                    )}
                  />
                ))}
              </SessionOverviewTable>
            )}
          </TabsContent>
        </Tabs>
        {state === "ready" ? (
          <div className="text-caption text-subtle-foreground">
            {shown.length}개 표시 · 검색은 지금 불러온 세션 안에서만 찾습니다.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SessionListV4Screen(props: Parameters<typeof SessionListV4Body>[0]) {
  return (
    <ScreenShell current="sessions" crumb={["세션"]}>
      <SessionListV4Body {...props} />
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Session list (v4)",
  component: SessionListV4Screen,
  parameters: { layout: "fullscreen" },
  args: { state: "ready" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["ready", "loading", "empty", "error"],
    },
  },
} satisfies Meta<typeof SessionListV4Screen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SessionListV4: Story = { name: "Ready" };
export const SessionListV4Dark: Story = {
  name: "Ready (dark)",
  globals: { theme: "dark" },
};
export const SessionListV4Mobile: Story = {
  name: "Ready (390px)",
  globals: MOBILE,
};
export const SessionListV4MobileDark: Story = {
  name: "Ready (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
export const SessionListV4NoMatch: Story = {
  name: "No match",
  args: { initialQuery: "없는 세션" },
};
export const SessionListV4Loading: Story = {
  name: "Loading",
  args: { state: "loading" },
};
export const SessionListV4Empty: Story = {
  name: "Empty",
  args: { state: "empty" },
};
export const SessionListV4Error: Story = {
  name: "Error",
  args: { state: "error" },
};

/*
 * The status column both ways, for the call the user left open ("이건
 * 고민되네"): today's badge (SessionStatusLabel) beside the v4 dot. The real
 * screen takes the dot.
 */
function StatusColumnCompareScreen() {
  return (
    <div className="grid gap-6 p-6 md:grid-cols-2">
      {(["badge", "dot"] as const).map((mark) => (
        <div key={mark} className="flex flex-col gap-3">
          <Badge variant={mark === "dot" ? "blue" : "gray"}>
            {mark === "dot" ? "시안 v4: 색 점 + 글자" : "현재안: 상태 배지"}
          </Badge>
          <div className="flex flex-col gap-3 rounded-card border bg-card p-4">
            {ROWS.map(({ summary: session, waitedMinutes }) => {
              const label =
                waitedMinutes === undefined
                  ? statusWord(session.status)
                  : `${statusWord(session.status)} · ${waitedMinutes}분`;
              return mark === "dot" ? (
                <StatusLabel
                  key={session.id}
                  appearance="dot"
                  axis="session"
                  state={session.status}
                  label={label}
                  axisLabel="작업 상태"
                />
              ) : (
                <div key={session.id} className="flex">
                  <SessionStatusLabel
                    status={session.status}
                    label={label}
                    axisLabel="작업 상태"
                  />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export const StatusColumnCompare: StoryObj<typeof StatusColumnCompareScreen> = {
  name: "Status column: current vs v4",
  render: () => <StatusColumnCompareScreen />,
};
export const StatusColumnCompareDark: StoryObj<
  typeof StatusColumnCompareScreen
> = {
  name: "Status column: current vs v4 (dark)",
  render: () => <StatusColumnCompareScreen />,
  globals: { theme: "dark" },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@werft-ai/ui";
import { Clock } from "lucide-react";
import { type ReactNode, useState } from "react";

import { MOBILE, PartRequest, ScreenShell } from "./screen-kit.tsx";

/*
 * v4 usage & limits (Console.dc.html L766-783), as apps/web draws it. Only
 * figures the API returns appear: the KPIs are GET /v1/usage/summary, the
 * limits table GET /v1/limits (the operator's alone). The design's breakdown
 * table, previous-period delta and per-person slot cap have no API and are
 * left out rather than drawn empty.
 */

type Viewer = "owner" | "member";
type Scope = "me" | "installation";
type State = "ready" | "loading" | "empty" | "error";

// Values GET /v1/usage/summary and GET /v1/limits return.
const SUMMARY = {
  me: {
    sessions: "12",
    runTime: "3시간 20분",
    cost: "$4.20",
    tokens: "1,234,567",
    complete: false,
  },
  installation: {
    sessions: "1,284",
    runTime: "412시간 0분",
    cost: "$182.40",
    tokens: "98,765,432",
    complete: true,
  },
} as const;

const KPI_LABEL =
  "m-0 flex items-center gap-2 text-control text-muted-foreground";
const KPI_NUM = "m-0 font-semibold text-number tracking-[-0.5px] tabular-nums";
const META = "m-0 text-caption text-subtle-foreground";

function Kpi({
  label,
  tag,
  value,
  note,
}: {
  readonly label: string;
  readonly tag?: string;
  readonly value: string;
  readonly note: string;
}) {
  return (
    <li className="min-w-0">
      <Card className="h-full gap-3 p-4">
        <p className={KPI_LABEL}>
          {label}
          {tag ? <Badge>{tag}</Badge> : null}
        </p>
        <p className={KPI_NUM}>{value}</p>
        <p className={META}>{note}</p>
      </Card>
    </li>
  );
}

function Bar({ percent }: { readonly percent: number }) {
  return (
    <span
      aria-hidden="true"
      className="block h-1.5 w-[120px] overflow-hidden rounded-[3px] bg-active"
    >
      <span
        className="block h-full rounded-[3px] bg-(--ap-tone-progress-fg)"
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

function Usage({
  text,
  percent,
}: {
  readonly text: string;
  readonly percent: number;
}) {
  return (
    <span className="flex flex-col gap-1">
      <span className="tabular-nums">{text}</span>
      <Bar percent={percent} />
    </span>
  );
}

const PER_SESSION = (
  <span className="text-subtle-foreground">세션마다 셉니다</span>
);
const LIMITS: readonly (readonly [string, ReactNode, ReactNode, string])[] = [
  [
    "동시 실행 slot",
    <Usage key="s" text="3 / 8" percent={37.5} />,
    "8",
    "설치 설정의 상한. 빈 slot이 없으면 세션이 대기합니다",
  ],
  [
    "입력 메시지 저장",
    <Usage key="b" text="512MB" percent={50} />,
    "1GB",
    "세션에 보낸 입력 메시지만 셉니다. 결과물 용량은 아직 세지 않습니다",
  ],
  [
    "세션당 비용",
    PER_SESSION,
    "$5.00",
    "추정 비용이 넘은 세션은 새 turn을 시작하지 않습니다",
  ],
  [
    "세션당 토큰",
    PER_SESSION,
    <Badge key="t">설정 안 됨</Badge>,
    "토큰이 넘은 세션은 새 turn을 시작하지 않습니다",
  ],
  [
    "세션당 대기 입력",
    PER_SESSION,
    "20건",
    "세션 하나에 쌓아 둘 수 있는 입력 수",
  ],
  ["turn 최대 시간", PER_SESSION, "1시간 0분", "turn 하나가 돌 수 있는 시간"],
];

function UsageScreen({
  viewer,
  scope: initial,
  state,
}: {
  readonly viewer: Viewer;
  readonly scope: Scope;
  readonly state: State;
}) {
  const operator = viewer === "owner";
  const [picked, setPicked] = useState<Scope>(initial);
  const scope = operator ? picked : "me";
  const figures = SUMMARY[scope];
  return (
    <ScreenShell current="usage" crumb={["사용량·한도"]} role={viewer}>
      <div className="flex flex-col gap-[var(--ap-space-section)]">
        <PageHeader
          title="사용량·한도"
          description={
            operator
              ? "내 사용량과 설치 전체 사용량을 봅니다."
              : "내가 시작한 세션 기준 사용량입니다. 설치 전체 수치는 설치 운영자만 볼 수 있습니다."
          }
          actions={
            operator ? (
              <SegmentedControl
                aria-label="집계 범위"
                value={scope}
                onValueChange={(value) => setPicked(value as Scope)}
              >
                <SegmentedControlItem value="me">
                  내 사용량
                </SegmentedControlItem>
                <SegmentedControlItem value="installation">
                  설치 전체
                </SegmentedControlItem>
              </SegmentedControl>
            ) : undefined
          }
        />
        <div className="flex flex-wrap gap-2">
          <PartRequest name="StatCard" />
          <PartRequest name="Meter" />
        </div>
        <div className="flex flex-col gap-4">
          {state === "ready" || state === "empty" ? (
            <Alert icon={<Clock strokeWidth={1.5} />}>
              <AlertTitle>
                {scope === "installation"
                  ? "설치 전체"
                  : "내가 시작한 세션 기준"}{" "}
                · 2026-10-01 00:00 ~ 10-22 10:30 (UTC)
              </AlertTitle>
              <AlertDescription>
                {scope === "installation"
                  ? "이 기간에 시작한 모든 세션을 합산합니다. 이 범위는 설치 운영자만 볼 수 있습니다. 2026. 10. 22. 19:30에 읽은 값입니다."
                  : "이 기간에 내가 웹이나 내 key로 시작한 세션만 셉니다. 공유받은 세션은 빠집니다. 2026. 10. 22. 19:30에 읽은 값입니다."}
              </AlertDescription>
            </Alert>
          ) : null}
          {state === "loading" ? (
            <div
              aria-busy="true"
              className="grid grid-cols-2 gap-4 md:grid-cols-4"
            >
              {[0, 1, 2, 3].map((index) => (
                <Card key={index} className="gap-3.5 p-4">
                  <Skeleton width="40%" />
                  <Skeleton width="60%" height="24px" />
                  <Skeleton width="80%" />
                </Card>
              ))}
            </div>
          ) : state === "error" ? (
            <Card className="py-0">
              <ErrorState
                title="불러오지 못했습니다"
                message="서버에 문제가 생겼습니다. 잠시 뒤 다시 시도하세요."
                retry={() => {}}
                retryLabel="다시 시도"
              />
            </Card>
          ) : state === "empty" ? (
            <Card className="py-0">
              <EmptyState
                title="아직 사용 기록이 없습니다"
                description="이 기간에 시작한 세션이 생기면 여기에 나옵니다."
              />
            </Card>
          ) : (
            <ul className="m-0 grid list-none grid-cols-2 gap-4 p-0 md:grid-cols-4">
              <Kpi
                label="세션"
                value={figures.sessions}
                note="이 기간에 시작한 세션"
              />
              <Kpi
                label="실행 시간"
                value={figures.runTime}
                note="turn 시작부터 끝까지, 답을 기다린 시간 포함"
              />
              <Kpi
                label="비용"
                tag="추정"
                value={figures.cost}
                note={
                  figures.complete
                    ? "provider 청구액과 다를 수 있음"
                    : "진행 중이거나 비용을 보고하지 않은 turn이 있어 실제보다 적을 수 있음"
                }
              />
              <Kpi
                label="토큰"
                value={figures.tokens}
                note="비용을 센 호출의 토큰"
              />
            </ul>
          )}
        </div>
        {operator ? (
          <div className="flex min-w-0 flex-col gap-[var(--ap-space-block)]">
            <div className="flex min-h-7 items-center justify-between gap-3">
              <h2 className="m-0 font-semibold text-body">한도</h2>
              <p className={META}>
                설치 전체에 적용됩니다 · 2026. 10. 22. 19:30 기준
              </p>
            </div>
            <TableContainer label="한도">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>항목</TableHead>
                    <TableHead>현재</TableHead>
                    <TableHead>한도</TableHead>
                    <TableHead>설명</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {LIMITS.map(([name, current, limit, note]) => (
                    <TableRow key={name}>
                      <TableCell variant="nowrap" className="font-medium">
                        {name}
                      </TableCell>
                      <TableCell variant="nowrap">{current}</TableCell>
                      <TableCell variant="nowrap" className="tabular-nums">
                        {limit}
                      </TableCell>
                      <TableCell
                        variant="text"
                        className="text-subtle-foreground"
                      >
                        {note}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </div>
        ) : null}
      </div>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Usage (v4)",
  component: UsageScreen,
  parameters: { layout: "fullscreen" },
  args: { viewer: "owner", scope: "me", state: "ready" },
  argTypes: {
    viewer: { control: "inline-radio", options: ["owner", "member"] },
    scope: { control: "inline-radio", options: ["me", "installation"] },
    state: {
      control: "inline-radio",
      options: ["ready", "loading", "empty", "error"],
    },
  },
} satisfies Meta<typeof UsageScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UsageOwner: Story = { name: "Owner (my usage)" };
export const UsageInstallation: Story = {
  name: "Owner (whole install)",
  args: { scope: "installation" },
};
export const UsageMember: Story = {
  name: "Member",
  args: { viewer: "member" },
};
export const UsageLoading: Story = {
  name: "Loading",
  args: { state: "loading" },
};
export const UsageEmpty: Story = { name: "Empty", args: { state: "empty" } };
export const UsageError: Story = { name: "Error", args: { state: "error" } };
export const UsageDark: Story = {
  name: "Owner (dark)",
  globals: { theme: "dark" },
};
export const UsageMobile: Story = { name: "Owner (390px)", globals: MOBILE };
export const UsageMobileDark: Story = {
  name: "Owner (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

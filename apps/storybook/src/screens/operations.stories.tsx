import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  DetailLayout,
  DetailRail,
  DetailRailSection,
  Findings,
  SessionCounts,
  ToolCalls,
  ToolsSummary,
  ToolTable,
} from "@werft-ai/react/components";
import {
  Badge,
  BarChart,
  BarChartLegend,
  Card,
  CardContent,
  EmptyState,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  KeyValueList,
  Link,
  LinkTab,
  LinkTabs,
  Meter,
  PageHeader,
  RowList,
  RowListItem,
  SearchInput,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Skeleton,
  Sparkline,
  StatCard,
  Text,
} from "@werft-ai/ui";
import { createContext, type ReactNode, useContext, useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { TOOL_NOTE, TOOLS } from "../domain/operations/operations-fixtures.ts";
import {
  breakdown,
  LIMITS,
  SESSION_COUNTS,
  series,
  summaryOf,
  toolDetail,
  type UsageBreakdownRow,
  type UsageSeriesResponse,
} from "./operations-fixtures.ts";
import { MOBILE, ScreenShell } from "./screen-kit.tsx";

/*
 * The operations menu (ops-console ccdeck-features-design.html, approved),
 * built from the kit before any API exists. Every block is a kit or
 * operations part; the data is the design's own, as API responses.
 */

type Tab = "overview" | "usage" | "tools" | "limits";
type Role = "owner" | "admin" | "member";
type Days = 7 | 30 | 90;

const TABS: readonly (readonly [Tab, string])[] = [
  ["overview", "개요"],
  ["usage", "사용량"],
  ["tools", "도구 활동"],
  ["limits", "한도"],
];

// ---------- display transforms (not API fields) ----------
const nf = new Intl.NumberFormat("ko-KR");
const usd = (s: string | number) =>
  `$${Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tok = (n: number) =>
  n >= 1e8
    ? `${(n / 1e8).toFixed(1)}억`
    : n >= 1e4
      ? `${nf.format(Math.round(n / 1e4))}만`
      : nf.format(n);
const dur = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
};
const bytes = (n: number) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(1).replace(/\.0$/, "")} GB`
    : `${Math.round(n / 1048576)} MB`;
const monthDay = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

interface ScreenData {
  readonly role: Role;
  readonly days: Days;
  readonly series: UsageSeriesResponse;
  readonly empty: boolean;
  readonly loading?: boolean;
}

function data(role: Role, days: Days, empty = false, partial?: number[]) {
  const s = series(days, partial);
  return {
    role,
    days,
    empty,
    series: empty
      ? {
          ...s,
          buckets: s.buckets.map((b) => ({
            ...b,
            session_count: 0,
            cost_usd: "0.00",
            cost_complete: true,
            token_count: 0,
            run_seconds: 0,
          })),
        }
      : s,
  } satisfies ScreenData;
}

// ---------- shared blocks ----------

/*
 * The Loading stories draw a screen from the same fixtures with each value
 * swapped for a bar at its line height and each chart or meter for a box of
 * its height, so the layout stands before the data and nothing moves when it
 * comes. Parts with a loading state of their own get `undefined`. The
 * placeholders are hidden from assistive tech; the screen says it once.
 */
const Loading = createContext(false);

function Value({
  children,
  width = "3rem",
}: {
  readonly children: ReactNode;
  readonly width?: string;
}) {
  return useContext(Loading) ? (
    // Inline so a value that shares a line ("7 / 10") keeps that line's box.
    <span
      aria-hidden="true"
      className="inline-block align-top"
      style={{ width }}
    >
      <Skeleton height="1lh" className="justify-center" />
    </span>
  ) : (
    children
  );
}

// BarChart's rendered height, full and compact, x labels included.
const BAR_CHART_HEIGHT = "11.25rem";
const RAIL_CHART_HEIGHT = "5.25rem";

// A block skeleton is at least 4rem; shorter boxes center a text bar.
function Box({
  height,
  chart = false,
}: {
  readonly height: string;
  readonly chart?: boolean;
}) {
  return (
    <div aria-hidden="true">
      <Skeleton
        shape={chart ? "block" : "text"}
        height={height}
        className="justify-center"
      />
    </div>
  );
}

function Filters({ role, days }: { readonly role: Role; readonly days: Days }) {
  const [scope, setScope] = useState(role === "owner" ? "installation" : "me");
  const [period, setPeriod] = useState(String(days));
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2">
      {role === "owner" ? (
        <SegmentedControl
          aria-label="집계 범위"
          value={scope}
          onValueChange={setScope}
        >
          <SegmentedControlItem value="me">내 사용량</SegmentedControlItem>
          <SegmentedControlItem value="installation">
            설치 전체
          </SegmentedControlItem>
        </SegmentedControl>
      ) : null}
      <SegmentedControl
        aria-label="기간"
        value={period}
        onValueChange={setPeriod}
        className="ml-auto"
      >
        <SegmentedControlItem value="7">7일</SegmentedControlItem>
        <SegmentedControlItem value="30">30일</SegmentedControlItem>
        <SegmentedControlItem value="90">90일</SegmentedControlItem>
      </SegmentedControl>
    </div>
  );
}

function Head({ tab, viewer }: { readonly tab: Tab; readonly viewer: Role }) {
  return (
    <>
      <PageHeader
        title="운영"
        description="에이전트가 얼마나 돌고, 얼마나 쓰고, 어디서 막히는지 봅니다."
      />
      <LinkTabs aria-label="운영 탭" className="mb-6">
        {TABS.filter(([id]) => id !== "limits" || viewer === "owner").map(
          ([id, label]) => (
            <LinkTab key={id} href={`#operations/${id}`} current={id === tab}>
              {label}
            </LinkTab>
          ),
        )}
      </LinkTabs>
    </>
  );
}

function More({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="whitespace-nowrap font-normal text-caption leading-4"
    >
      {children}
    </Link>
  );
}

function Kpis({ screen }: { readonly screen: ScreenData }) {
  const s = summaryOf(screen.series);
  const loading = useContext(Loading);
  const field = (pick: (b: UsageSeriesResponse["buckets"][number]) => number) =>
    screen.series.buckets.map(pick);
  const spark = (values: readonly number[], label: string) =>
    loading ? (
      <Box height="2rem" />
    ) : (
      <Sparkline values={values} label={label} />
    );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
      <StatCard
        label="세션"
        value={<Value>{nf.format(s.session_count)}</Value>}
        chart={spark(
          field((b) => b.session_count),
          "일자별 세션 수",
        )}
        description="이 기간에 시작한 세션"
      />
      <StatCard
        label="실행 시간"
        value={<Value width="6rem">{dur(s.run_seconds)}</Value>}
        chart={spark(
          field((b) => b.run_seconds),
          "일자별 실행 시간",
        )}
        description="turn 시작부터 끝까지, 답을 기다린 시간 포함"
      />
      <StatCard
        label="비용"
        badge={<Badge>추정</Badge>}
        value={<Value width="5rem">{usd(s.cost_usd)}</Value>}
        chart={spark(
          field((b) => Number(b.cost_usd)),
          "일자별 비용",
        )}
        description={
          s.cost_complete
            ? undefined
            : "진행 중이거나 비용을 보고하지 않은 turn이 있어 실제보다 적을 수 있음"
        }
      />
      <StatCard
        label="토큰"
        value={<Value width="4rem">{tok(s.token_count)}</Value>}
        chart={spark(
          field((b) => b.token_count),
          "일자별 토큰",
        )}
        description="비용을 센 호출의 토큰"
      />
    </div>
  );
}

/** Model, agent and top-agent tables: a name over a cost bar, then figures. */
function CostTable({
  label,
  rows,
  head,
  mono = false,
  tokens = true,
}: {
  readonly label: string;
  readonly rows: readonly UsageBreakdownRow[];
  readonly head: string;
  readonly mono?: boolean;
  readonly tokens?: boolean;
}) {
  const max = Math.max(...rows.map((r) => Number(r.cost_usd)));
  const loading = useContext(Loading);
  return (
    <Card flush>
      <GridTable
        aria-label={label}
        {...(tokens
          ? {
              columns: "minmax(0,1fr) 56px 80px 96px",
              narrowAt: 480 as const,
              narrowColumns: "minmax(0,1fr) 48px 88px",
            }
          : { columns: "minmax(0,1fr) 64px 96px" })}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{head}</GridTableColumnHeader>
          <GridTableColumnHeader align="end">세션</GridTableColumnHeader>
          {tokens ? (
            <GridTableColumnHeader align="end" hideNarrow>
              토큰
            </GridTableColumnHeader>
          ) : null}
          <GridTableColumnHeader align="end">비용</GridTableColumnHeader>
        </GridTableHeader>
        {rows.map((row) => (
          <GridTableRow key={row.key}>
            <GridTableCell lines className="gap-1">
              <Text
                as="span"
                className={mono ? "font-mono text-control" : undefined}
              >
                <Value width="8rem">{row.label}</Value>
              </Text>
              {loading ? (
                <Box height="0.25rem" />
              ) : (
                <Meter
                  size="inline"
                  value={Number(row.cost_usd)}
                  max={max}
                  label={`${row.label} 비용 비율`}
                  className="w-full"
                />
              )}
            </GridTableCell>
            <GridTableCell align="end" className="tabular-nums">
              <Value width="1.5rem">{row.session_count}</Value>
            </GridTableCell>
            {tokens ? (
              <GridTableCell align="end" hideNarrow className="tabular-nums">
                <Value>{tok(row.token_count)}</Value>
              </GridTableCell>
            ) : null}
            <GridTableCell align="end" className="tabular-nums">
              <Value>{usd(row.cost_usd)}</Value>
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
    </Card>
  );
}

const statusLink = (
  status: string,
  link: { readonly className: string; readonly children: ReactNode },
) => (
  <a href={`#/sessions?status=${status}`} className={link.className}>
    {link.children}
  </a>
);

// ---------- tabs ----------

function Overview({ screen }: { readonly screen: ScreenData }) {
  const agents = breakdown(summaryOf(screen.series)).agent.rows.slice(0, 3);
  const zero = {
    queued: 0,
    running: 0,
    needs_input: 0,
    idle: 0,
    failed: 0,
    stopped: 0,
  };
  const loading = useContext(Loading);
  return (
    <div
      aria-busy={loading || undefined}
      className="flex min-w-0 flex-col gap-8"
    >
      <SessionCounts
        counts={
          loading ? undefined : screen.empty ? zero : SESSION_COUNTS.counts
        }
        slots={
          screen.role !== "owner"
            ? undefined
            : loading
              ? null
              : {
                  used: LIMITS.usage.execution_slots_used,
                  limit: LIMITS.limits.execution_slot_limit,
                }
        }
        statusLink={statusLink}
      />
      <div>
        <Filters role={screen.role} days={screen.days} />
        <Section
          title={`최근 ${screen.days}일`}
          actions={<More href="#operations/usage">사용량 자세히</More>}
        >
          <Kpis screen={screen} />
        </Section>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section
          title="살펴볼 것"
          description="도구 호출 기록에서 찾았습니다"
          actions={<More href="#operations/tools">도구 활동</More>}
        >
          {loading ? (
            <RowList variant="joined" aria-hidden="true">
              {TOOLS.findings.map(({ kind }) => (
                <RowListItem key={kind} className="min-h-16">
                  <Skeleton width="60%" lines={2} />
                </RowListItem>
              ))}
            </RowList>
          ) : (
            <Findings
              data={screen.empty ? { tools: [], findings: [] } : TOOLS}
            />
          )}
        </Section>
        <Section
          title="비용이 큰 에이전트"
          description={`최근 ${screen.days}일 추정 비용 순`}
        >
          {screen.empty ? (
            <EmptyState title="이 기간에 비용을 쓴 에이전트가 없습니다." />
          ) : (
            <CostTable
              label="비용이 큰 에이전트"
              head="에이전트"
              rows={agents}
              tokens={false}
            />
          )}
        </Section>
      </div>
    </div>
  );
}

function Usage({ screen }: { readonly screen: ScreenData }) {
  const summary = summaryOf(screen.series);
  const split = breakdown(summary);
  const totals = split.model.totals;
  const total = totals.token_count;
  const first = screen.series.buckets[0]?.date ?? "";
  const last = screen.series.buckets.at(-1)?.date ?? "";
  const scope = screen.role === "owner" ? "설치 전체" : "내 사용량";
  const loading = useContext(Loading);
  if (screen.empty) {
    return (
      <div className="flex min-w-0 flex-col gap-8">
        <Kpis screen={screen} />
        <EmptyState title="이 기간에 시작한 세션이 없습니다." />
      </div>
    );
  }
  return (
    <div
      aria-busy={loading || undefined}
      className="flex min-w-0 flex-col gap-8"
    >
      <Kpis screen={screen} />
      <Text variant="meta" className="-mt-4 leading-4">
        {scope} · {first} – {last} (UTC) · 비용·토큰·실행 시간은 세션을 시작한
        날에 붙습니다 · 오후 9:40에 읽은 값
      </Text>
      <Section
        title="일자별 비용"
        description="막대에 올리면 그날의 비용과 세션 수가 나옵니다"
        actions={
          <BarChartLegend
            items={[
              { label: "비용 보고 끝남" },
              { label: "보고 안 된 비용 있음", partial: true },
            ]}
          />
        }
      >
        <Card>
          <CardContent>
            {loading ? (
              <Box chart height={BAR_CHART_HEIGHT} />
            ) : (
              <BarChart
                label={`일자별 추정 비용, ${screen.days}일`}
                data={screen.series.buckets.map((b) => ({
                  x: b.date,
                  y: Number(b.cost_usd),
                  partial: !b.cost_complete,
                }))}
                yMax={
                  Math.ceil(
                    Math.max(
                      ...screen.series.buckets.map((b) => Number(b.cost_usd)),
                    ) / 20,
                  ) * 20
                }
                formatX={monthDay}
                formatY={(y) => `$${Math.round(y)}`}
                formatTip={(d) => {
                  const bucket = screen.series.buckets.find(
                    (b) => b.date === d.x,
                  );
                  return `${monthDay(d.x)} · ${usd(d.y)} · 세션 ${bucket?.session_count ?? 0}개${d.partial ? " · 보고 안 된 비용 있음" : ""}`;
                }}
              />
            )}
          </CardContent>
        </Card>
      </Section>
      <Section
        title="토큰 구성"
        description={`비용을 센 호출의 토큰 ${tok(total)}을 종류별로 나눴습니다`}
      >
        <Card flush>
          <GridTable
            aria-label="토큰 구성"
            columns="96px minmax(0,1fr) 80px 56px"
          >
            {(
              [
                ["입력", "input_tokens"],
                ["출력", "output_tokens"],
                ["캐시 읽기", "cache_read_input_tokens"],
                ["캐시 쓰기", "cache_creation_input_tokens"],
              ] as const
            ).map(([label, key]) => (
              <GridTableRow key={key}>
                <GridTableCell>{label}</GridTableCell>
                <GridTableCell>
                  {loading ? (
                    <Box height="0.25rem" />
                  ) : (
                    <Meter
                      size="inline"
                      value={totals[key]}
                      max={total}
                      label={`${label} 토큰 비율`}
                      className="w-full"
                    />
                  )}
                </GridTableCell>
                <GridTableCell align="end" className="tabular-nums">
                  <Value>{tok(totals[key])}</Value>
                </GridTableCell>
                <GridTableCell
                  align="end"
                  className="text-subtle-foreground tabular-nums"
                >
                  <Value width="2rem">
                    {Math.round((100 * totals[key]) / total)}%
                  </Value>
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </Card>
      </Section>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section title="모델별">
          <CostTable label="모델별" head="모델" rows={split.model.rows} mono />
        </Section>
        <Section title="에이전트별">
          <CostTable
            label="에이전트별"
            head="에이전트"
            rows={split.agent.rows}
          />
        </Section>
      </div>
    </div>
  );
}

function Tools({
  screen,
  hideSessions = false,
}: {
  readonly screen: ScreenData;
  readonly hideSessions?: boolean | undefined;
}) {
  const [sort, setSort] = useState("calls");
  const [callSort, setCallSort] = useState("recent");
  const [selected, setSelected] = useState("Bash");
  const loading = useContext(Loading);
  const tools = screen.empty ? [] : TOOLS.tools;
  const tool = TOOLS.tools.find((t) => t.name === selected) ?? TOOLS.tools[0];
  const detail = tool ? toolDetail(tool) : { calls: [], perDay: [] };
  const calls = hideSessions
    ? detail.calls.map((call) => ({ ...call, session_id: null, title: null }))
    : detail.calls;
  const peak = detail.perDay.reduce(
    (a, b) => (b.calls > a.calls ? b : a),
    detail.perDay[0] ?? { date: "", calls: 0 },
  );
  const perDayTotal = detail.perDay.reduce((sum, d) => sum + d.calls, 0);
  const rail =
    tool && !screen.empty ? (
      <DetailRail label="선택한 도구">
        <DetailRailSection
          title={
            <Text as="span" mono className="text-body font-semibold leading-5">
              {tool.name}
            </Text>
          }
          description={TOOL_NOTE[tool.name]?.ko}
        >
          <KeyValueList
            items={[
              { label: "호출", value: `${nf.format(tool.calls)}번` },
              { label: "총 시간", value: dur(tool.total_ms / 1000) },
              {
                label: "보통",
                value:
                  tool.median_ms >= 60000
                    ? dur(tool.median_ms / 1000)
                    : `${(tool.median_ms / 1000).toFixed(1)}초`,
              },
              {
                label: "실패",
                value: `${tool.failed}번 (${((100 * tool.failed) / tool.calls).toFixed(1)}%)`,
              },
            ].map((item) => ({
              ...item,
              value: <Value width="4rem">{item.value}</Value>,
            }))}
          />
        </DetailRailSection>
        <DetailRailSection title="일자별 호출" description="최근 14일">
          {loading ? (
            <Box chart height={RAIL_CHART_HEIGHT} />
          ) : (
            <BarChart
              compact
              data={detail.perDay.map((d) => ({ x: d.date, y: d.calls }))}
              yMax={peak.calls}
              label={`${tool.name} 일자별 호출, 최근 14일, 합계 ${nf.format(perDayTotal)}번, 가장 많은 날 ${monthDay(peak.date)} ${peak.calls}번`}
              formatX={monthDay}
            />
          )}
        </DetailRailSection>
        <DetailRailSection
          title="최근 호출"
          actions={
            <SegmentedControl
              aria-label="호출 정렬"
              value={callSort}
              onValueChange={setCallSort}
            >
              <SegmentedControlItem value="recent">최근</SegmentedControlItem>
              <SegmentedControlItem value="slowest">
                느린 순
              </SegmentedControlItem>
            </SegmentedControl>
          }
        >
          {loading ? (
            <div aria-hidden="true">
              <Skeleton lines={3} />
            </div>
          ) : (
            <ToolCalls calls={calls} timeZone="Asia/Seoul" />
          )}
        </DetailRailSection>
      </DetailRail>
    ) : undefined;
  return (
    <DetailLayout rail={rail}>
      <Head tab="tools" viewer={screen.role} />
      <Filters role={screen.role} days={screen.days} />
      <div
        aria-busy={loading || undefined}
        className="flex min-w-0 flex-col gap-8"
      >
        {screen.empty ? null : loading ? (
          <div aria-hidden="true">
            <Skeleton lines={2} height="3rem" className="justify-around" />
          </div>
        ) : (
          <ToolsSummary tools={tools} period={`최근 ${screen.days}일`} />
        )}
        <Section
          title="도구와 명령"
          badge={
            <Badge>
              <Value width="0.75rem">{tools.length}</Value>
            </Badge>
          }
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl
              aria-label="정렬"
              value={sort}
              onValueChange={setSort}
            >
              <SegmentedControlItem value="calls">
                많이 쓴 순
              </SegmentedControlItem>
              <SegmentedControlItem value="time">
                오래 걸린 순
              </SegmentedControlItem>
              <SegmentedControlItem value="slow">느린 순</SegmentedControlItem>
              <SegmentedControlItem value="failed">실패</SegmentedControlItem>
            </SegmentedControl>
            <SearchInput
              aria-label="도구 찾기"
              type="search"
              placeholder="도구나 명령 찾기"
              wrapperClassName="max-w-none flex-[1_1_100%] sm:ml-auto sm:w-60 sm:flex-none"
            />
          </div>
          <ToolTable
            tools={loading ? undefined : tools}
            label="도구와 명령"
            selected={selected}
            onSelect={setSelected}
            describe={(name) => TOOL_NOTE[name]?.ko}
          />
        </Section>
      </div>
    </DetailLayout>
  );
}

function Limits({ limits = LIMITS }: { readonly limits?: typeof LIMITS }) {
  const L = limits.limits;
  const U = limits.usage;
  const loading = useContext(Loading);
  const perSession = (
    <Text as="span" variant="sub" className="text-subtle-foreground">
      세션마다 셉니다
    </Text>
  );
  const rows: readonly (readonly [string, ReactNode, ReactNode, string])[] = [
    [
      "동시 실행 slot",
      `${U.execution_slots_used} / ${L.execution_slot_limit}`,
      nf.format(L.execution_slot_limit),
      "설치 설정의 상한. 빈 slot이 없으면 세션이 대기합니다",
    ],
    [
      "입력 메시지 저장",
      bytes(U.storage.used_bytes),
      bytes(L.storage_limit_bytes),
      "세션에 보낸 입력 메시지만 셉니다. 결과물 용량은 아직 세지 않습니다",
    ],
    [
      "세션당 비용",
      perSession,
      usd(L.session_cost_limit_usd),
      "추정 비용이 넘은 세션은 새 turn을 시작하지 않습니다",
    ],
    [
      "세션당 토큰",
      perSession,
      L.session_token_limit === null ? (
        <Badge key="unset">설정 안 됨</Badge>
      ) : (
        nf.format(L.session_token_limit)
      ),
      "토큰이 넘은 세션은 새 turn을 시작하지 않습니다",
    ],
    [
      "세션당 대기 입력",
      perSession,
      `${nf.format(L.queued_input_limit_per_session)}건`,
      "세션 하나에 쌓아 둘 수 있는 입력 수",
    ],
    [
      "turn 최대 시간",
      perSession,
      dur(L.max_turn_seconds),
      "turn 하나가 돌 수 있는 시간",
    ],
  ];
  return (
    <div
      aria-busy={loading || undefined}
      className="flex min-w-0 flex-col gap-8"
    >
      <Section
        title="실행 용량"
        description="설치 전체에 적용됩니다 · 오후 9:40 기준"
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
          <StatCard
            label="사용 중인 slot"
            value={<Value width="4rem">{U.execution_slots_used}</Value>}
            outOf={<Value width="1.5rem">{L.execution_slot_limit}</Value>}
            chart={
              loading ? (
                <Box height="0.5rem" />
              ) : (
                <Meter
                  value={U.execution_slots_used}
                  max={L.execution_slot_limit}
                  label="slot 사용률"
                />
              )
            }
            description={
              <Value width="5rem">
                {`빈 slot ${L.execution_slot_limit - U.execution_slots_used}개`}
              </Value>
            }
          />
          <StatCard
            label="입력 메시지 저장"
            value={<Value width="4rem">{bytes(U.storage.used_bytes)}</Value>}
            outOf={<Value width="3rem">{bytes(L.storage_limit_bytes)}</Value>}
            chart={
              loading ? (
                <Box height="0.5rem" />
              ) : (
                <Meter
                  value={U.storage.used_bytes}
                  max={L.storage_limit_bytes}
                  label="입력 메시지 저장 사용률"
                />
              )
            }
            description="입력 메시지만 셉니다"
          />
        </div>
      </Section>
      <Section title="한도">
        <Card flush>
          <GridTable
            aria-label="한도"
            columns="minmax(0,1fr) 128px 112px minmax(0,1.6fr)"
            narrowAt={480}
            narrowColumns="minmax(0,1fr) 112px 80px"
          >
            <GridTableHeader>
              <GridTableColumnHeader>항목</GridTableColumnHeader>
              <GridTableColumnHeader>현재</GridTableColumnHeader>
              <GridTableColumnHeader>한도</GridTableColumnHeader>
              <GridTableColumnHeader hideNarrow>설명</GridTableColumnHeader>
            </GridTableHeader>
            {rows.map(([item, now, limit, note]) => (
              <GridTableRow key={item}>
                <GridTableCell>{item}</GridTableCell>
                <GridTableCell className="tabular-nums">
                  <Value>{now}</Value>
                </GridTableCell>
                <GridTableCell className="tabular-nums">
                  <Value>{limit}</Value>
                </GridTableCell>
                <GridTableCell hideNarrow className="text-muted-foreground">
                  {note}
                </GridTableCell>
              </GridTableRow>
            ))}
          </GridTable>
        </Card>
      </Section>
    </div>
  );
}

function OperationsScreen({
  tab,
  screen,
  hideSessions,
}: {
  readonly tab: Tab;
  readonly screen: ScreenData;
  readonly hideSessions?: boolean | undefined;
}) {
  return (
    <Loading.Provider value={screen.loading ?? false}>
      <output className="sr-only">
        {screen.loading ? "운영 화면을 읽는 중" : ""}
      </output>
      {tab === "tools" ? (
        <ScreenShell
          current="operations"
          crumb={["업무", "운영"]}
          role={screen.role}
          width="flush"
        >
          <Tools screen={screen} hideSessions={hideSessions} />
        </ScreenShell>
      ) : (
        <ScreenShell
          current="operations"
          crumb={["업무", "운영"]}
          role={screen.role}
        >
          <Head tab={tab} viewer={screen.role} />
          {tab === "usage" ? (
            <Filters role={screen.role} days={screen.days} />
          ) : null}
          {tab === "overview" ? <Overview screen={screen} /> : null}
          {tab === "usage" ? <Usage screen={screen} /> : null}
          {tab === "limits" ? <Limits /> : null}
        </ScreenShell>
      )}
    </Loading.Provider>
  );
}

const meta = {
  title: "Screens/Operations",
  component: OperationsScreen,
  parameters: { layout: "fullscreen" },
  args: { tab: "overview", screen: data("owner", 30) },
} satisfies Meta<typeof OperationsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" } as const;
const LOADING = { ...data("owner", 30), loading: true };

export const OverviewOwner: Story = {};
export const OverviewAdmin: Story = { args: { screen: data("admin", 30) } };
export const OverviewMember: Story = { args: { screen: data("member", 30) } };
export const OverviewEmpty: Story = {
  args: { screen: data("owner", 30, true) },
};
/** No value or meter is drawn yet; the screen and the counts each say so once. */
export const OverviewLoading: Story = {
  args: { screen: LOADING },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole("meter")).toHaveLength(0);
    expect(
      canvas.getAllByRole("status").map((status) => status.textContent),
    ).toEqual(["운영 화면을 읽는 중", "세션 수를 읽는 중"]);
  },
};
export const OverviewDark: Story = { globals: DARK };
export const OverviewMobile: Story = {
  name: "Overview Owner (390px)",
  globals: MOBILE,
};

export const UsageOwner: Story = { args: { tab: "usage" } };
export const Usage7Days: Story = {
  args: { tab: "usage", screen: data("owner", 7) },
};
export const Usage90Days: Story = {
  args: { tab: "usage", screen: data("owner", 90) },
};
export const UsageEmpty: Story = {
  args: { tab: "usage", screen: data("owner", 30, true) },
};
/** A past day with unreported cost is hatched too, not only today. */
export const UsageCostIncomplete: Story = {
  args: { tab: "usage", screen: data("owner", 30, false, [5, 12, 29]) },
};
export const UsageLoading: Story = {
  args: { tab: "usage", screen: LOADING },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole("meter")).toHaveLength(0);
    expect(canvas.getAllByRole("status")).toHaveLength(1);
  },
};
export const UsageDark: Story = { args: { tab: "usage" }, globals: DARK };
export const UsageMobile: Story = {
  name: "Usage Owner (390px)",
  args: { tab: "usage" },
  globals: MOBILE,
};

export const ToolsOwner: Story = { args: { tab: "tools" } };
/** Owner, sessions outside what they may read: no title, no link. */
/** Choosing another tool moves the whole rail to it, chart and calls too. */
export const ToolsSelectRead: Story = {
  args: { tab: "tools" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Read 자세히 보기" }),
    );
    const rail = within(
      canvas.getByRole("complementary", { name: "선택한 도구" }),
    );
    await expect(rail.getByRole("heading", { name: "Read" })).toBeVisible();
    const read = TOOLS.tools.find((t) => t.name === "Read");
    const total = read
      ? toolDetail(read).perDay.reduce((sum, d) => sum + d.calls, 0)
      : 0;
    await expect(
      rail.getByRole("img", {
        name: new RegExp(
          `^Read 일자별 호출, 최근 14일, 합계 ${nf.format(total)}번`,
        ),
      }),
    ).toBeVisible();
    await expect(rail.queryByText(/Bash/)).toBeNull();
  },
};

export const ToolsHiddenSessions: Story = {
  args: { tab: "tools", hideSessions: true },
};
export const ToolsRailBelow1280: Story = {
  name: "Tools (768px, rail below)",
  args: { tab: "tools" },
  globals: { viewport: { value: "tablet768", isRotated: false } },
};
export const ToolsEmpty: Story = {
  args: { tab: "tools", screen: data("owner", 30, true) },
};
export const ToolsLoading: Story = {
  args: { tab: "tools", screen: LOADING },
};
export const ToolsDark: Story = { args: { tab: "tools" }, globals: DARK };
export const ToolsMobile: Story = {
  name: "Tools Owner (390px)",
  args: { tab: "tools" },
  globals: MOBILE,
};
export const ToolsMobileDark: Story = {
  name: "Tools Owner (390px, dark)",
  args: { tab: "tools" },
  globals: { ...MOBILE, ...DARK },
};

/** The design's installation sets no token limit: "설정 안 됨". */
export const LimitsOwner: Story = { args: { tab: "limits" } };
export const LimitsTokenLimitSet: Story = {
  name: "Limits (token limit set)",
  args: { tab: "limits" },
  render: () => (
    <ScreenShell current="operations" crumb={["업무", "운영"]}>
      <Head tab="limits" viewer="owner" />
      <Limits
        limits={{
          ...LIMITS,
          limits: { ...LIMITS.limits, session_token_limit: 2_000_000 },
        }}
      />
    </ScreenShell>
  ),
};
export const LimitsLoading: Story = {
  args: { tab: "limits", screen: LOADING },
};
export const LimitsDark: Story = { args: { tab: "limits" }, globals: DARK };
export const LimitsMobile: Story = {
  name: "Limits Owner (390px)",
  args: { tab: "limits" },
  globals: MOBILE,
};

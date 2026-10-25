import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UsageSummaryScope } from "@werft-ai/contracts";
import {
  DetailLayout,
  Findings,
  findTools,
  InstallationLimits,
  MoreLink,
  OperationsHead,
  type OperationsTab,
  SessionCounts,
  sortTools,
  type ToolCallSort,
  ToolRail,
  type ToolSort,
  ToolsFilter,
  ToolsSummary,
  ToolTable,
  UsageFilters,
  UsageKpis,
  type UsagePeriod,
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
  Link,
  Meter,
  Section,
  Skeleton,
  Text,
} from "@werft-ai/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

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

type Tab = OperationsTab;
type Role = "owner" | "admin" | "member";
type Days = UsagePeriod;

const TABS: readonly Tab[] = ["overview", "usage", "tools", "limits"];

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
    <Skeleton
      inline
      decorative
      width={width}
      height="1lh"
      className="justify-center"
    />
  ) : (
    children
  );
}

// BarChart's rendered height, x labels included.
const BAR_CHART_HEIGHT = "11.25rem";

// A block skeleton is at least 4rem; shorter boxes center a text bar.
function Box({
  height,
  chart = false,
}: {
  readonly height: string;
  readonly chart?: boolean;
}) {
  return (
    <Skeleton
      decorative
      shape={chart ? "block" : "text"}
      height={height}
      className="justify-center"
    />
  );
}

function Filters({ role, days }: { readonly role: Role; readonly days: Days }) {
  const [scope, setScope] = useState<UsageSummaryScope>(
    role === "owner" ? "installation" : "me",
  );
  const [period, setPeriod] = useState<UsagePeriod>(days);
  return (
    <UsageFilters
      {...(role === "owner" ? { scope, onScopeChange: setScope } : {})}
      days={period}
      onDaysChange={setPeriod}
    />
  );
}

function Head({ tab, viewer }: { readonly tab: Tab; readonly viewer: Role }) {
  return (
    <OperationsHead
      tabs={TABS.filter((id) => id !== "limits" || viewer === "owner")}
      current={tab}
      tabLink={(id, label) => <a href={`#operations/${id}`}>{label}</a>}
    />
  );
}

function Kpis({ screen }: { readonly screen: ScreenData }) {
  const loading = useContext(Loading);
  return (
    <UsageKpis
      buckets={loading ? undefined : screen.series.buckets}
      messages={{ loading: "" }}
    />
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
  <Link
    href={`#/sessions?status=${status}`}
    underline={null}
    className={link.className}
  >
    {link.children}
  </Link>
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
        messages={{ loading: "" }}
      />
      <div>
        <Filters role={screen.role} days={screen.days} />
        <Section
          title={`최근 ${screen.days}일`}
          actions={<MoreLink href="#operations/usage">사용량 자세히</MoreLink>}
        >
          <Kpis screen={screen} />
        </Section>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Section
          title="살펴볼 것"
          description="도구 호출 기록에서 찾았습니다"
          actions={<MoreLink href="#operations/tools">도구 활동</MoreLink>}
        >
          <Findings
            data={
              loading
                ? undefined
                : screen.empty
                  ? { tools: [], findings: [] }
                  : TOOLS
            }
            loadingRows={TOOLS.findings.length}
          />
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
  hideNotes = false,
}: {
  readonly screen: ScreenData;
  readonly hideSessions?: boolean | undefined;
  readonly hideNotes?: boolean | undefined;
}) {
  const note = (name: string) => (hideNotes ? undefined : TOOL_NOTE[name]?.ko);
  const [sort, setSort] = useState<ToolSort>("calls");
  const [query, setQuery] = useState("");
  const [callSort, setCallSort] = useState<ToolCallSort>("recent");
  const [selected, setSelected] = useState("Bash");
  const loading = useContext(Loading);
  const tools = screen.empty
    ? []
    : findTools(sortTools(TOOLS.tools, sort), query);
  const tool = TOOLS.tools.find((t) => t.name === selected) ?? TOOLS.tools[0];
  const detail = tool ? toolDetail(tool) : { calls: [], perDay: [] };
  const calls = hideSessions
    ? detail.calls.map((call) => ({ ...call, session_id: null, title: null }))
    : detail.calls;
  const rail =
    tool && !screen.empty ? (
      <ToolRail
        name={tool.name}
        tool={loading ? undefined : tool}
        note={note(tool.name)}
        perDay={loading ? undefined : detail.perDay}
        calls={loading ? undefined : calls}
        callSort={callSort}
        onCallSortChange={setCallSort}
        timeZone="Asia/Seoul"
      />
    ) : undefined;
  return (
    <DetailLayout rail={rail}>
      <Head tab="tools" viewer={screen.role} />
      <Filters role={screen.role} days={screen.days} />
      <div
        aria-busy={loading || undefined}
        className="@container flex min-w-0 flex-col gap-8"
      >
        {screen.empty ? null : (
          <ToolsSummary
            tools={loading ? undefined : TOOLS.tools}
            period={`최근 ${screen.days}일`}
          />
        )}
        <Section
          title="도구와 명령"
          badge={
            <Badge>
              <Value width="0.75rem">
                {screen.empty ? 0 : TOOLS.tools.length}
              </Value>
            </Badge>
          }
        >
          <ToolsFilter
            sort={sort}
            onSortChange={setSort}
            onQueryChange={setQuery}
          />
          <ToolTable
            tools={loading ? undefined : tools}
            label="도구와 명령"
            selected={selected}
            onSelect={setSelected}
            describe={hideNotes ? undefined : note}
            loadingRows={TOOLS.tools.length}
            searched={query !== ""}
          />
        </Section>
      </div>
    </DetailLayout>
  );
}

function Limits({ limits = LIMITS }: { readonly limits?: typeof LIMITS }) {
  const loading = useContext(Loading);
  return (
    <InstallationLimits
      limits={loading ? undefined : limits}
      timeZone="Asia/Seoul"
      messages={{ loading: "" }}
    />
  );
}

function OperationsScreen({
  tab,
  screen,
  hideSessions,
  hideNotes,
}: {
  readonly tab: Tab;
  readonly screen: ScreenData;
  readonly hideSessions?: boolean | undefined;
  readonly hideNotes?: boolean | undefined;
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
          flush
        >
          <Tools
            screen={screen}
            hideSessions={hideSessions}
            hideNotes={hideNotes}
          />
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

// Set by each mounted Arriving screen, per tab: its play calls it so the data
// comes to that screen only.
const arrive = new Map<Tab, () => void>();

/** One screen, mounted once, that starts reading and then gets its data. */
function Arriving({ tab }: { readonly tab: Tab }) {
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const done = () => setLoading(false);
    arrive.set(tab, done);
    return () => {
      if (arrive.get(tab) === done) arrive.delete(tab);
    };
  }, [tab]);
  return <OperationsScreen tab={tab} screen={{ ...LOADING, loading }} />;
}

const BLOCKS =
  "h1, h2, h3, [role=table], [role=row], [data-slot=card], [role=tablist], aside, li";
const layout = (root: HTMLElement) =>
  [...root.querySelectorAll(BLOCKS)].map((block) => {
    const { top, left, width, height } = block.getBoundingClientRect();
    const name = block.matches("h1, h2, h3")
      ? block.textContent
      : (block.getAttribute("aria-label") ??
        block.getAttribute("role") ??
        block.tagName);
    return `${name} ${top},${left},${width},${height}`;
  });

/** The data replaces each placeholder in place, and nothing else changes. */
const loadingToLoaded = (tab: Tab): Story => ({
  args: { tab },
  render: () => <Arriving tab={tab} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const period =
      tab === "limits" ? null : canvas.getByRole("button", { name: "7일" });
    if (period) await userEvent.click(period);
    const before = layout(canvasElement);
    arrive.get(tab)?.();
    await waitFor(() =>
      expect(canvas.getByRole("status").textContent).toBe(""),
    );
    expect(canvasElement.querySelector("[aria-busy=true]")).toBeNull();
    if (tab !== "tools") {
      expect(canvas.getAllByRole("meter").length).toBeGreaterThan(0);
    }
    expect(layout(canvasElement)).toEqual(before);
    // Still the same mount: what the viewer chose while it read stays.
    if (period) expect(period.getAttribute("aria-pressed")).toBe("true");
  },
});

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
/** No value or meter is drawn yet, and the screen says so once. */
export const OverviewLoading: Story = {
  args: { screen: LOADING },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole("meter")).toHaveLength(0);
    expect(
      canvas.getAllByRole("status").map((status) => status.textContent),
    ).toEqual(["운영 화면을 읽는 중"]);
  },
};
export const OverviewLoadingToLoaded = loadingToLoaded("overview");
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
export const UsageLoadingToLoaded = loadingToLoaded("usage");
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
/**
 * The app until the notes have a source (94S-936): no note under a name, so
 * every row is one line shorter, loading rows too.
 */
export const ToolsWithoutNotes: Story = {
  args: { tab: "tools", hideNotes: true },
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
  play: async ({ canvasElement }) => {
    expect(within(canvasElement).getAllByRole("status")).toHaveLength(1);
  },
};
export const ToolsLoadingToLoaded = loadingToLoaded("tools");
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryAllByRole("meter")).toHaveLength(0);
    expect(canvas.getAllByRole("status")).toHaveLength(1);
  },
};
export const LimitsLoadingToLoaded = loadingToLoaded("limits");
export const LimitsDark: Story = { args: { tab: "limits" }, globals: DARK };
export const LimitsMobile: Story = {
  name: "Limits Owner (390px)",
  args: { tab: "limits" },
  globals: MOBILE,
};

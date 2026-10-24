import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  GridTable,
  GridTableCell,
  GridTableColumnHeader,
  GridTableHeader,
  GridTableRow,
  GridTableRowOpener,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@werft-ai/ui";
import type { ReactNode } from "react";
import { expect } from "storybook/test";

// Console v4 column templates (Console.dc.html L292-294, L302).
const T_SESS =
  "minmax(0,2.2fr) 120px minmax(0,1.1fr) minmax(0,1.1fr) minmax(0,1fr) 72px";
const T_SESS_HOME =
  "minmax(0,2.2fr) 120px minmax(0,1.2fr) minmax(0,1.2fr) 72px";
const T_SESS_NARROW = "minmax(0,2fr) 116px minmax(0,1.2fr) 64px";
const T_MEM = "minmax(0,1.6fr) 120px minmax(0,1.4fr) minmax(0,1fr)";
// An example only: v4 gives .t-mem no narrow template, and which column the
// members screen drops is that screen's call.
const T_MEM_NARROW = "minmax(0,1.6fr) 120px minmax(0,1fr)";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    sessions: "세션",
    recent: "최근 세션",
    members: "구성원",
    loading: "세션 불러오는 중",
    title: "제목",
    status: "상태",
    agent: "에이전트",
    repo: "저장소",
    starter: "시작한 사람",
    updated: "최근 활동",
    name: "이름",
    role: "역할",
    agents: "관리하는 에이전트",
    last: "최근 접속",
    open: (title: string) => `세션 열기: ${title}`,
    openMember: (name: string) => `구성원 열기: ${name}`,
    changeRole: "역할 변경",
    running: "실행 중",
    waiting: "답변 대기",
    done: "끝남",
    via: "Slack에서",
    owner: "소유자",
    member: "구성원",
    ago: (n: number) => `${n}분 전`,
  },
  ja: {
    sessions: "セッション",
    recent: "最近のセッション",
    members: "メンバー",
    loading: "セッションを読み込み中",
    title: "タイトル",
    status: "状態",
    agent: "エージェント",
    repo: "リポジトリ",
    starter: "開始した人",
    updated: "最近の活動",
    name: "名前",
    role: "ロール",
    agents: "管理するエージェント",
    last: "最終アクセス",
    open: (title: string) => `セッションを開く: ${title}`,
    openMember: (name: string) => `メンバーを開く: ${name}`,
    changeRole: "ロール変更",
    running: "実行中",
    waiting: "回答待ち",
    done: "終了",
    via: "Slackから",
    owner: "オーナー",
    member: "メンバー",
    ago: (n: number) => `${n}分前`,
  },
  en: {
    sessions: "Sessions",
    recent: "Recent sessions",
    members: "Members",
    loading: "Loading sessions",
    title: "Title",
    status: "Status",
    agent: "Agent",
    repo: "Repository",
    starter: "Started by",
    updated: "Last activity",
    name: "Name",
    role: "Role",
    agents: "Agents managed",
    last: "Last seen",
    open: (title: string) => `Open session: ${title}`,
    openMember: (name: string) => `Open member: ${name}`,
    changeRole: "Change role",
    running: "Running",
    waiting: "Waiting for reply",
    done: "Ended",
    via: "from Slack",
    owner: "Owner",
    member: "Member",
    ago: (n: number) => `${n} min ago`,
  },
} as const;

type Copy = (typeof COPY)[keyof typeof COPY];

function copyOf(locale: unknown): Copy {
  return locale === "ja" || locale === "en" ? COPY[locale] : COPY.ko;
}

const LONG_TITLE =
  "Investigate why the nightly billing export to the warehouse drops rows when the upstream invoice batch is retried after a timeout";

const SESSIONS = [
  {
    id: "ses_01JBA7V0M3",
    title: "배포 점검",
    status: "running",
    agent: "Release helper",
    model: "claude-opus-5-5",
    repo: "werft-ai/agent-platform",
    starter: "김하나",
    minutes: 3,
  },
  {
    id: "ses_01JBA6Q2KD",
    title: "요금 분석 리포트",
    status: "waiting",
    agent: "Billing analyst",
    model: "claude-sonnet-5-5",
    repo: "werft-ai/billing",
    starter: "Alex Rivera",
    minutes: 18,
  },
  {
    id: "ses_01JBA4Z8XR",
    title: "온보딩 문서 정리",
    status: "done",
    agent: "Docs writer",
    model: "claude-haiku-5-5",
    repo: "werft-ai/docs",
    starter: "佐藤 花子",
    minutes: 52,
  },
] as const;

const MEMBERS = [
  {
    name: "김하나",
    email: "hana@example.com",
    owner: true,
    agents: "Release helper, Billing analyst",
    minutes: 2,
  },
  {
    name: "Alex Rivera",
    email: "alex.rivera.long-address@example.com",
    owner: false,
    agents: "Docs writer",
    minutes: 40,
  },
  {
    name: "佐藤 花子",
    email: "hanako.sato@example.com",
    owner: false,
    agents: "—",
    minutes: 9,
  },
] as const;

function Frame({ children }: { readonly children: ReactNode }) {
  return <div className="rounded-card border bg-card">{children}</div>;
}

function SessionTitle({
  title,
  id,
}: {
  readonly title: string;
  readonly id: string;
}) {
  return (
    <>
      <span className="max-w-full truncate font-medium text-foreground">
        {title}
      </span>
      <span className="font-mono text-caption text-subtle-foreground">
        {id}
      </span>
    </>
  );
}

type SessionsProps = {
  readonly locale: unknown;
  readonly home?: boolean;
  readonly long?: boolean;
  readonly rows?: number;
  readonly busy?: boolean;
};

/** v4 sessions list (`.t-sess`, L579-581) and home (`.t-sess-home`, L557-559). */
function Sessions({
  locale,
  home = false,
  long = false,
  rows = 3,
  busy,
}: SessionsProps) {
  const t = copyOf(locale);
  return (
    <Frame>
      <GridTable
        aria-label={busy ? t.loading : home ? t.recent : t.sessions}
        aria-busy={busy}
        columns={home ? T_SESS_HOME : T_SESS}
        narrowAt={820}
        narrowColumns={T_SESS_NARROW}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{t.title}</GridTableColumnHeader>
          <GridTableColumnHeader>{t.status}</GridTableColumnHeader>
          <GridTableColumnHeader>{t.agent}</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            {t.repo}
          </GridTableColumnHeader>
          {home ? null : (
            <GridTableColumnHeader hideNarrow={true}>
              {t.starter}
            </GridTableColumnHeader>
          )}
          <GridTableColumnHeader align="end">{t.updated}</GridTableColumnHeader>
        </GridTableHeader>
        {SESSIONS.slice(0, rows).map((session, index) => {
          const title = long && index === 0 ? LONG_TITLE : session.title;
          return (
            <GridTableRow key={session.id}>
              <GridTableCell lines={true}>
                <GridTableRowOpener aria-label={t.open(title)} />
                <SessionTitle title={title} id={session.id} />
              </GridTableCell>
              <GridTableCell>{t[session.status]}</GridTableCell>
              <GridTableCell lines={true}>
                <span className="max-w-full truncate">{session.agent}</span>
                <span className="font-mono text-caption text-subtle-foreground">
                  {session.model}
                </span>
              </GridTableCell>
              <GridTableCell hideNarrow={true}>
                <span className="truncate">
                  {long && index === 0
                    ? "werft-ai/agent-platform-infrastructure-and-deploy-scripts"
                    : session.repo}
                </span>
              </GridTableCell>
              {home ? null : (
                <GridTableCell lines={true} hideNarrow={true}>
                  <span className="max-w-full truncate">{session.starter}</span>
                  <span className="text-caption text-subtle-foreground">
                    {t.via}
                  </span>
                </GridTableCell>
              )}
              <GridTableCell
                align="end"
                className="text-caption text-subtle-foreground"
              >
                {t.ago(session.minutes)}
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </GridTable>
    </Frame>
  );
}

type MembersProps = {
  readonly locale: unknown;
  readonly clickable?: boolean;
};

/**
 * v4 members (`.t-mem`, L847-848): avatar, name at weight 500 over the email,
 * role badge in a fixed 120px column. The narrow template is an example.
 */
function Members({ locale, clickable = false }: MembersProps) {
  const t = copyOf(locale);
  return (
    <Frame>
      <GridTable
        aria-label={t.members}
        columns={T_MEM}
        narrowAt={640}
        narrowColumns={T_MEM_NARROW}
      >
        <GridTableHeader>
          <GridTableColumnHeader>{t.name}</GridTableColumnHeader>
          <GridTableColumnHeader>{t.role}</GridTableColumnHeader>
          <GridTableColumnHeader hideNarrow={true}>
            {t.agents}
          </GridTableColumnHeader>
          <GridTableColumnHeader>{t.last}</GridTableColumnHeader>
        </GridTableHeader>
        {MEMBERS.map((member) => (
          <GridTableRow key={member.email}>
            <GridTableCell>
              {clickable ? (
                <GridTableRowOpener
                  aria-label={t.openMember(member.name)}
                  asChild={true}
                >
                  {/* biome-ignore lint/a11y/useAnchorContent: the opener's aria-label names the link. */}
                  <a href={`#members/${member.email}`} />
                </GridTableRowOpener>
              ) : null}
              {/* Stands in for Avatar until it lands in the kit. */}
              <span
                aria-hidden="true"
                className="inline-grid size-6 shrink-0 place-items-center rounded-full bg-active font-semibold text-2xs text-muted-foreground"
              >
                {member.name.slice(0, 1)}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-foreground">
                  {member.name}
                </span>
                <span
                  className="truncate text-caption text-subtle-foreground"
                  title={member.email}
                >
                  {member.email}
                </span>
              </span>
            </GridTableCell>
            <GridTableCell raised={clickable}>
              {clickable ? (
                <Button type="button" variant="outline" size="sm">
                  {t.changeRole}
                </Button>
              ) : (
                <Badge variant={member.owner ? "blue" : "gray"}>
                  {member.owner ? t.owner : t.member}
                </Badge>
              )}
            </GridTableCell>
            <GridTableCell hideNarrow={true}>
              <span className="truncate">{member.agents}</span>
            </GridTableCell>
            <GridTableCell className="text-caption text-subtle-foreground">
              {t.ago(member.minutes)}
            </GridTableCell>
          </GridTableRow>
        ))}
      </GridTable>
    </Frame>
  );
}

// At whatever width the story runs: the hideNarrow columns are gone exactly
// when the table is at or below its narrowAt width, the template has one track
// per column header left, every row as many cells, and nothing scrolls
// sideways.
async function expectAlignedColumns(canvasElement: HTMLElement) {
  const shown = (row: Element, role: string) =>
    [...row.querySelectorAll(`[role=${role}]`)].filter(
      (cell) => getComputedStyle(cell).display !== "none",
    ).length;
  for (const table of canvasElement.querySelectorAll("[role=table]")) {
    const [head, ...rows] = table.querySelectorAll("[role=row]");
    if (head === undefined) throw new Error("no header row");
    const narrowAt = Number(table.getAttribute("data-narrow-at"));
    const narrow = table.clientWidth <= narrowAt;
    for (const header of head.querySelectorAll("[data-hide-narrow]")) {
      await expect(getComputedStyle(header).display === "none").toBe(narrow);
    }
    const headers = shown(head, "columnheader");
    await expect(
      getComputedStyle(head).gridTemplateColumns.split(" ").length,
    ).toBe(headers);
    for (const row of rows) await expect(shown(row, "cell")).toBe(headers);
    await expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth);
  }
  // A two-line cell: 20px first line, 16px after it, the opener aside.
  for (const cell of canvasElement.querySelectorAll("[data-lines]")) {
    const lines = [...cell.children].filter(
      (line) => !line.matches("[data-slot=grid-table-row-opener]"),
    );
    await expect(
      lines.map((line) => getComputedStyle(line).lineHeight),
    ).toEqual(["20px", ...lines.slice(1).map(() => "16px")]);
  }
}

const meta = {
  title: "Primitives/GridTable",
  component: GridTable,
  // Each render supplies its own table.
  args: { "aria-label": COPY.ko.sessions, columns: T_SESS },
  play: ({ canvasElement }) => expectAlignedColumns(canvasElement),
} satisfies Meta<typeof GridTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * v4 `.t-sess`: six columns, the whole row opens the session. At 820px of
 * table width and below, repository and starter drop out and the template
 * becomes four columns.
 */
export const SessionList: Story = {
  name: "Session list",
  render: (_, { globals }) => <Sessions locale={globals.locale} />,
};

/** v4 `.t-sess-home`: the home page's five columns, same narrow template. */
export const Home: Story = {
  render: (_, { globals }) => <Sessions locale={globals.locale} home={true} />,
};

/**
 * v4 `.t-mem`: the role column stays 120px whatever the badge says, and the
 * name is weight 500. Below 640px the agents column drops out (an example;
 * v4 has no narrow members template).
 */
export const MemberList: Story = {
  name: "Members",
  render: (_, { globals }) => <Members locale={globals.locale} />,
};

/**
 * Rows that open as a whole, with a button in a raised cell that takes its
 * own click. The opener here is a link (`asChild`).
 */
export const ClickableRows: Story = {
  name: "Clickable rows with a button",
  render: (_, { globals }) => (
    <Members locale={globals.locale} clickable={true} />
  ),
  play: async ({ canvasElement }) => {
    await expectAlignedColumns(canvasElement);
    // What a pointer hits: the button in the raised cell over its own
    // centre, the row's opener over the plain cells.
    const row = canvasElement.querySelectorAll("[role=row]")[1];
    const button = row?.querySelector("button");
    // The last cell: never hidden when narrow.
    const plain = row?.querySelector("[role=cell]:last-child");
    if (!(button && plain)) throw new Error("no row");
    const hit = (element: Element) => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2,
      );
    };
    await expect(hit(button)?.closest("button") === button).toBe(true);
    await expect(hit(plain)?.matches("[data-slot=grid-table-row-opener]")).toBe(
      true,
    );
  },
};

/**
 * `inactive` rows: every cell but the actions turns faint and its badges lose
 * their hue, a badge under `TooltipTrigger asChild` included; the raised
 * actions cell keeps full contrast, its Button under a trigger too. The name
 * says "inactive" in text.
 */
export const InactiveRows: Story = {
  name: "Inactive rows",
  render: () => (
    <Frame>
      <GridTable
        aria-label="구성원"
        columns="minmax(0,1.6fr) 120px minmax(var(--ap-row-action-min-width),1fr)"
      >
        <GridTableHeader>
          <GridTableColumnHeader>구성원</GridTableColumnHeader>
          <GridTableColumnHeader>역할</GridTableColumnHeader>
          <GridTableColumnHeader align="end">관리</GridTableColumnHeader>
        </GridTableHeader>
        {[
          { name: "김하나", inactive: false, tooltip: false },
          { name: "이두리", inactive: true, tooltip: false },
          { name: "박세찬", inactive: true, tooltip: true },
        ].map((row) => {
          const action = (
            <Button type="button" variant="outline" size="sm">
              {row.inactive ? "다시 활성화" : "비활성화"}
            </Button>
          );
          return (
            <GridTableRow key={row.name} inactive={row.inactive}>
              <GridTableCell lines={true}>
                <span className="font-medium text-foreground">
                  {row.name}
                  {row.inactive ? (
                    <span className="sr-only"> (비활성)</span>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-xs">
                  {row.name}@example.test
                </span>
              </GridTableCell>
              <GridTableCell>
                {row.tooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild={true}>
                      <Badge variant="blue" tabIndex={0}>
                        관리자
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>워크스페이스를 관리합니다</TooltipContent>
                  </Tooltip>
                ) : (
                  <Badge variant="blue">관리자</Badge>
                )}
              </GridTableCell>
              <GridTableCell align="end" raised={true}>
                {row.tooltip ? (
                  <Tooltip>
                    <TooltipTrigger asChild={true}>{action}</TooltipTrigger>
                    <TooltipContent>다시 들어올 수 있게 합니다</TooltipContent>
                  </Tooltip>
                ) : (
                  action
                )}
              </GridTableCell>
            </GridTableRow>
          );
        })}
      </GridTable>
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const [, active, inactive, tooltipped] = [
      ...canvasElement.querySelectorAll("[role=row]"),
    ];
    if (!(active && inactive && tooltipped)) throw new Error("no rows");
    const colour = (row: Element, selector: string) => {
      const element = row.querySelector(selector);
      if (!element) throw new Error(`no ${selector}`);
      return getComputedStyle(element).color;
    };
    const probe = document.createElement("span");
    probe.style.color = "var(--ap-color-subtle-foreground)";
    canvasElement.append(probe);
    const subtle = getComputedStyle(probe).color;
    probe.remove();
    for (const row of [inactive, tooltipped]) {
      await expect(colour(row, ".font-medium")).toBe(subtle);
      await expect(colour(row, "[role=cell]:nth-child(2) > *")).toBe(subtle);
      await expect(colour(row, "button")).not.toBe(subtle);
    }
    await expect(colour(active, ".font-medium")).not.toBe(subtle);
    await expect(colour(active, "[role=cell]:nth-child(2) > *")).not.toBe(
      subtle,
    );
  },
};

export const InactiveRowsDark: Story = {
  ...InactiveRows,
  name: "Inactive rows (dark)",
  globals: { theme: "dark" },
};

/** Long text ends in "…" inside its column instead of widening the table. */
export const LongText: Story = {
  name: "Long text",
  render: (_, { globals }) => <Sessions locale={globals.locale} long={true} />,
};

/** No rows yet: the header alone, without a bottom rule. */
export const Empty: Story = {
  render: (_, { globals }) => <Sessions locale={globals.locale} rows={0} />,
};

/** `aria-busy` passes through; the skeleton rows are the screen's. */
export const Loading: Story = {
  render: (_, { globals }) => (
    <Sessions locale={globals.locale} rows={0} busy={true} />
  ),
};

export const SessionListDark: Story = {
  ...SessionList,
  name: "Session list (dark)",
  globals: { theme: "dark" },
};

export const MembersDark: Story = {
  ...ClickableRows,
  name: "Clickable rows (dark)",
  globals: { theme: "dark" },
};

export const SessionList390: Story = {
  ...SessionList,
  name: "Session list (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Home390: Story = {
  ...Home,
  name: "Home (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Members390: Story = {
  ...MemberList,
  name: "Members (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Japanese: Story = {
  ...SessionList,
  name: "Session list (ja)",
  globals: { locale: "ja" },
};

export const English: Story = {
  ...SessionList,
  name: "Session list (en)",
  globals: { locale: "en" },
};

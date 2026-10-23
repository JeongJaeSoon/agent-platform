import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  cn,
  Link,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { LayoutGrid, List } from "lucide-react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";
import { storyHref } from "./slack-kit.tsx";

/*
 * The agent list's Slack column (v3-ia.md §3.5) on apps/web agents.tsx's
 * table view: between the state and the updated time at 1280; below 480px
 * the column hides with the updated one and its word moves into the first
 * cell as a link.
 */

type Slack = "connected" | "action" | "error" | "none";

interface Row {
  readonly name: string;
  readonly slug: string;
  readonly draft: boolean;
  readonly slack: Slack;
  readonly why: string;
  readonly story: string;
}

const DETAIL = "screens-agent-detail-v3--agent-detail";
const UPDATED = "2026. 10. 23. 21:48";
const SLACK = {
  connected: ["연결됨", "green"],
  action: ["조치 필요", "amber"],
  error: ["오류", "red"],
  none: ["연결 안 됨", "gray"],
} as const;

const RELEASE_NOTES: Row = {
  name: "Release Notes",
  slug: "release-notes",
  draft: false,
  slack: "connected",
  why: "@release-notes",
  story: `${DETAIL}-slack-overview`,
};
const ROWS = {
  ok: [RELEASE_NOTES],
  mixed: [
    {
      ...RELEASE_NOTES,
      slack: "action",
      why: "승인 요청 1건",
      story: `${DETAIL}-slack-todo`,
    },
    {
      name: "On-call Helper",
      slug: "oncall-helper",
      draft: false,
      slack: "error",
      why: "이벤트 주소 확인 실패",
      story: `${DETAIL}-slack-error`,
    },
    {
      name: "Docs Tidy",
      slug: "docs-tidy",
      draft: true,
      slack: "none",
      why: "",
      story: `${DETAIL}-slack-none`,
    },
  ],
} as const satisfies Record<string, readonly Row[]>;

// agents.tsx: FIT shrinks a column to its content; WIDE hides it below 480px.
const FIT = "w-px whitespace-nowrap";
const WIDE = "hidden @[480px]:table-cell";
const LAST_WHEN_NARROW =
  "pr-[var(--ap-row-padding-x)] @[480px]:pr-[calc(var(--ap-row-padding-x)/2)]";
const SECONDARY = "text-caption text-muted-foreground";

function AgentTable({ rows }: { readonly rows: readonly Row[] }) {
  return (
    <div className="@container overflow-hidden rounded-card border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">에이전트</TableHead>
            <TableHead scope="col" className={cn(FIT, LAST_WHEN_NARROW)}>
              상태
            </TableHead>
            <TableHead scope="col" className={cn(FIT, WIDE)}>
              Slack
            </TableHead>
            <TableHead scope="col" className={cn(FIT, WIDE, "text-right")}>
              수정
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const [word, tone] = SLACK[row.slack];
            const href = storyHref(row.story);
            return (
              <TableRow key={row.slug}>
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-[var(--ap-row-line-gap)] leading-4">
                    <Link
                      href={storyHref(`${DETAIL}-overview-tab`)}
                      className="leading-5 [overflow-wrap:anywhere]"
                    >
                      {row.name}
                    </Link>
                    <div className="font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">
                      {row.slug}
                    </div>
                    <Link href={href} className="text-caption @[480px]:hidden">
                      {row.why ? `Slack ${word} · ${row.why}` : `Slack ${word}`}
                    </Link>
                    <div className={`${SECONDARY} @[480px]:hidden`}>
                      {UPDATED} 수정
                    </div>
                  </div>
                </TableCell>
                <TableCell className={cn(FIT, LAST_WHEN_NARROW)}>
                  <Badge variant={row.draft ? "gray" : "green"}>
                    {row.draft ? "초안" : "활성"}
                  </Badge>
                </TableCell>
                <TableCell className={cn(FIT, WIDE)}>
                  <div className="flex flex-col gap-[var(--ap-row-line-gap)]">
                    <Badge asChild variant={tone}>
                      <a href={href} aria-label={`${row.name} Slack ${word}`}>
                        {word}
                      </a>
                    </Badge>
                    {row.why ? (
                      <div className={`${SECONDARY} leading-4`}>{row.why}</div>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell
                  className={cn(
                    FIT,
                    WIDE,
                    "text-right text-caption text-muted-foreground",
                  )}
                >
                  <time>{UPDATED}</time>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function AgentListScreen({ rows }: { readonly rows: "ok" | "mixed" }) {
  const agents = ROWS[rows];
  return (
    <ScreenShell current="agents" crumb={["에이전트"]}>
      <PageHeader
        title="에이전트"
        description="에이전트는 카드·배포 판·관리자를 가진 작업자입니다. 관리자는 그 에이전트 세션의 요청에 답합니다."
        actions={
          <Button asChild>
            <a href={storyHref("screens-new-agent-v3--new-agent-slack-allow")}>
              새 에이전트
            </a>
          </Button>
        }
      />
      <Tabs defaultValue="all" className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="all">
              전체
              <Badge variant="gray">{agents.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="administered">
              관리하는 에이전트
              <Badge variant="gray">{agents.length}</Badge>
            </TabsTrigger>
          </TabsList>
          <fieldset className="m-0 inline-flex min-w-0 gap-1 border-0 p-0">
            <legend className="sr-only">보기</legend>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-pressed={false}
            >
              <LayoutGrid aria-hidden="true" />
              카드
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-pressed={true}
            >
              <List aria-hidden="true" />표
            </Button>
          </fieldset>
        </div>
        <TabsContent value="all">
          <AgentTable rows={agents} />
        </TabsContent>
        <TabsContent value="administered">
          <AgentTable rows={agents} />
        </TabsContent>
      </Tabs>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent list (v3)",
  component: AgentListScreen,
  parameters: { layout: "fullscreen" },
  args: { rows: "ok" },
} satisfies Meta<typeof AgentListScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const AgentListSlackOk: Story = { name: "Slack 열: 정상" };
export const AgentListSlackOkDark: Story = {
  name: "Slack 열: 정상 (dark)",
  globals: DARK,
};
export const AgentListSlackOkMobile: Story = {
  name: "Slack 열: 정상 (390px)",
  globals: MOBILE,
};

export const AgentListSlackMixed: Story = {
  name: "Slack 열: 섞임",
  args: { rows: "mixed" },
};
export const AgentListSlackMixedDark: Story = {
  ...AgentListSlackMixed,
  name: "Slack 열: 섞임 (dark)",
  globals: DARK,
};
export const AgentListSlackMixedMobile: Story = {
  ...AgentListSlackMixed,
  name: "Slack 열: 섞임 (390px)",
  globals: MOBILE,
};

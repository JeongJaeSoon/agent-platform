import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  cn,
  ErrorState,
  Link,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { ArrowLeft, Check, Copy } from "lucide-react";
import type { ReactNode } from "react";

import {
  LockedButton,
  MOBILE,
  PartRequest,
  ScreenShell,
} from "./screen-kit.tsx";

/*
 * Console v4 agent detail (Console.dc.html L709-788): one column, the
 * overview's three figures, the steps before the agent runs, recent
 * sessions; the card tab as words beside the raw card. Values are the
 * fields GET /v1/agents/{id} returns; what it does not return says so.
 */

type ScreenState = "owner" | "member-draft" | "loading" | "error";
type Tab = "overview" | "card";

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

const CARD = {
  role: "결제 문의 담당",
  instructions:
    "결제 실패·환불 문의를 받아 원인을 찾고, 필요한 경우 담당자에게 넘긴다.",
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: {
    tools: null,
    forbidden: ["Bash"],
    mcp: [{ server: "billing-db" }],
    credential_refs: ["BILLING_DB"],
  },
  rules: [],
};

interface Agent {
  readonly name: string;
  readonly slug: string;
  readonly released: boolean;
}

const RELEASED: Agent = { name: "결제 담당", slug: "billing", released: true };
const DRAFT: Agent = { name: "결제 담당", slug: "billing", released: false };

function Avatar({ name }: { readonly name: string }) {
  return (
    <div
      aria-hidden="true"
      className="grid size-8 flex-none place-items-center rounded-control bg-accent font-semibold text-caption text-muted-foreground"
    >
      {name.slice(0, 2)}
    </div>
  );
}

function Head({
  agent,
  manager,
}: {
  readonly agent: Agent;
  readonly manager: boolean;
}) {
  return (
    <PageHeader
      title={
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={agent.name} />
          {agent.name}
        </div>
      }
      description={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={agent.released ? "green" : "gray"}>
            {agent.released ? "사용 중" : "아직 쓸 수 없음"}
          </Badge>
          {CARD.role}
          <PartRequest name="Avatar" />
        </div>
      }
      actions={
        <>
          <Button variant="outline">
            <ArrowLeft aria-hidden="true" />
            에이전트 목록
          </Button>
          {manager ? null : <PartRequest name="Tooltip" />}
          <LockedButton
            label="이 에이전트로 새 세션"
            reason="웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요."
            size="default"
          />
        </>
      }
    />
  );
}

function AgentTabs({
  current,
  children,
}: {
  readonly current: Tab;
  readonly children: ReactNode;
}) {
  return (
    <Tabs value={current} className="gap-0">
      <div className="mb-6 border-b">
        <TabsList variant="line" aria-label="에이전트 상세" className="h-9 p-0">
          {(
            [
              ["overview", "개요"],
              ["card", "카드"],
              ["release", "배포"],
              ["admins", "관리자"],
            ] as const
          ).map(([value, label]) => (
            <TabsTrigger
              key={value}
              value={value}
              className="h-9 text-control after:bottom-0"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={current}>{children}</TabsContent>
    </Tabs>
  );
}

function Figure({
  label,
  value,
  note,
  tag,
  muted = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly note: string;
  readonly tag?: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Card className="h-full gap-3 p-4">
      <CardDescription className="flex items-center gap-2 text-control">
        {label}
        {tag}
      </CardDescription>
      <CardTitle
        className={cn(
          "text-number tabular-nums tracking-[-0.5px]",
          muted && "text-muted-foreground",
        )}
      >
        {value}
      </CardTitle>
      <CardDescription className="text-caption">{note}</CardDescription>
    </Card>
  );
}

function SectionHead({
  title,
  badge,
}: {
  readonly title: string;
  readonly badge?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <CardTitle>{title}</CardTitle>
      {badge}
    </div>
  );
}

const STEP_DONE =
  "border-(color:--ap-tone-success-border) bg-(color:--ap-tone-success-bg) text-(color:--ap-tone-success-fg)";

function Steps({
  steps,
}: {
  readonly steps: readonly {
    readonly title: string;
    readonly desc: string;
    readonly done: boolean;
    readonly action?: ReactNode;
  }[];
}) {
  return (
    <Card className="gap-0 p-4">
      <PartRequest name="Steps" />
      {steps.map((step, index) => (
        <div
          key={step.title}
          className="flex min-w-0 items-center gap-3 border-t py-3 first-of-type:border-t-0 last:pb-0"
        >
          <div
            aria-hidden="true"
            className={cn(
              "grid size-6 flex-none place-items-center rounded-full border font-semibold text-caption",
              step.done
                ? STEP_DONE
                : "border-(color:--ap-color-border-strong) text-muted-foreground",
            )}
          >
            {step.done ? <Check className="size-3.5" /> : index + 1}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <CardTitle className="font-medium text-control">
              {step.title}
            </CardTitle>
            <CardDescription className="text-caption">
              {step.desc}
            </CardDescription>
          </div>
          {step.action}
        </div>
      ))}
    </Card>
  );
}

function Overview({ agent }: { readonly agent: Agent }) {
  return (
    <div className="@container flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <PartRequest name="StatCard" />
        <div className="grid grid-cols-1 gap-4 @[720px]:grid-cols-3">
          <Figure
            label="배포된 버전"
            value={agent.released ? "version 2" : "없음"}
            muted={!agent.released}
            note={
              agent.released
                ? "실행 프로필 claude-coding"
                : "아직 켜지지 않았습니다. 배포 탭에서 release를 만들고 활성화하면 새 세션이 이 에이전트를 씁니다."
            }
          />
          <Figure
            label="최신 버전"
            value="version 2"
            note={
              agent.released
                ? "2026. 10. 22. 오후 2:00 · 새 세션은 최신 version으로 시작합니다."
                : "2026. 10. 22. 오후 2:00 · 아직 배포하지 않았습니다."
            }
          />
          <Figure
            label="답변 대기"
            tag={API_CHANGE}
            value="답변 대기: API 변경 필요"
            muted
            note="이 에이전트의 세션을 세는 API가 아직 없습니다."
          />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <SectionHead
          title="켜기까지"
          badge={
            <Badge variant={agent.released ? "green" : "amber"}>
              {agent.released ? "켜짐" : "할 일 있음"}
            </Badge>
          }
        />
        <Steps
          steps={[
            {
              title: "자격 증명 연결",
              desc: agent.released
                ? "필요한 1개를 모두 연결했습니다."
                : "연결이 필요합니다: BILLING_DB",
              done: agent.released,
              action: agent.released ? undefined : (
                <Button variant="outline">배포 탭으로</Button>
              ),
            },
            {
              title: "release 만들기",
              desc: agent.released
                ? "release 2개가 있습니다."
                : "배포 탭에서 version과 실행 프로필로 release를 만듭니다.",
              done: agent.released,
            },
            {
              title: "활성화",
              desc: agent.released
                ? "새 세션은 최신 version으로 시작합니다."
                : "아직 켜지지 않았습니다. 배포 탭에서 release를 만들고 활성화하면 새 세션이 이 에이전트를 씁니다.",
              done: agent.released,
            },
          ]}
        />
      </div>
      <div className="flex flex-col gap-3">
        <SectionHead title="최근 세션" badge={API_CHANGE} />
        <Card className="items-center gap-2 px-4 py-6 text-center">
          <CardTitle>
            이 에이전트의 세션을 고르는 API가 아직 없습니다.
          </CardTitle>
          <CardDescription className="text-control">
            그동안은 세션 목록에서 찾으세요.{" "}
            <Link href="#sessions">모든 세션</Link>
          </CardDescription>
        </Card>
      </div>
    </div>
  );
}

function Fact({
  term,
  children,
}: {
  readonly term: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

function Names({ items }: { readonly items: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} className="font-mono font-normal">
          {item}
        </Badge>
      ))}
    </div>
  );
}

function CardTab({ agent }: { readonly agent: Agent }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-4 @[720px]:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>에이전트 카드</CardTitle>
            <CardDescription className="text-caption">
              {agent.released
                ? "새 세션에 쓰이는 version입니다. 읽기 전용."
                : "아직 배포하지 않은 최신 version입니다. 읽기 전용."}
            </CardDescription>
            <CardAction>
              <Badge className="font-mono font-normal">version 2</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <dl className="m-0 grid grid-cols-1 items-baseline gap-x-4 gap-y-1 text-control sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-y-2">
              <Fact term="이름">{agent.name}</Fact>
              <Fact term="식별자">{agent.slug}</Fact>
              <Fact term="역할">{CARD.role}</Fact>
              <Fact term="지시 사항">{CARD.instructions}</Fact>
              <Fact term="모델">{CARD.model}</Fact>
              <Fact term="언어">한국어</Fact>
              <Fact term="쓸 수 있는 도구">프로필이 허용하는 도구 전부</Fact>
              <Fact term="금지 도구">
                <Names items={CARD.capabilities.forbidden} />
              </Fact>
              <Fact term="MCP">
                <Names
                  items={CARD.capabilities.mcp.map((server) => server.server)}
                />
              </Fact>
              <Fact term="자격 증명">
                <Names items={CARD.capabilities.credential_refs} />
              </Fact>
              <Fact term="GitHub 연동·저장소">{API_CHANGE}</Fact>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>카드 원문</CardTitle>
            <CardDescription className="text-caption">
              API가 돌려주는 카드 JSON
            </CardDescription>
            <CardAction>
              <Button variant="outline" size="sm">
                <Copy aria-hidden="true" className="size-3.5" />
                복사
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex-1">
            <pre className="m-0 h-full overflow-auto whitespace-pre-wrap rounded-control border bg-muted px-3 py-2 font-mono text-caption leading-[1.6] [overflow-wrap:anywhere]">
              {JSON.stringify(CARD, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AgentDetailScreen({
  state,
  tab,
}: {
  readonly state: ScreenState;
  readonly tab: Tab;
}) {
  const manager = state === "owner";
  const agent = state === "member-draft" ? DRAFT : RELEASED;
  return (
    <ScreenShell
      current="agents"
      crumb={["에이전트", agent.name]}
      role={manager ? "owner" : "member"}
    >
      {state === "loading" ? (
        <Card className="p-4">
          <Skeleton lines={4} label="불러오는 중입니다" />
        </Card>
      ) : state === "error" ? (
        <ErrorState
          title="에이전트를 불러오지 못했습니다."
          guidance="잠시 후 다시 시도하세요."
          code="INTERNAL"
        />
      ) : (
        <>
          <Head agent={agent} manager={manager} />
          <AgentTabs current={tab}>
            {tab === "overview" ? (
              <Overview agent={agent} />
            ) : (
              <CardTab agent={agent} />
            )}
          </AgentTabs>
        </>
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent detail (v4)",
  component: AgentDetailScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "owner", tab: "overview" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["owner", "member-draft", "loading", "error"],
    },
    tab: { control: "inline-radio", options: ["overview", "card"] },
  },
} satisfies Meta<typeof AgentDetailScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentDetail: Story = { name: "Overview (owner, released)" };
export const AgentDetailMemberDraft: Story = {
  name: "Overview (member, not released)",
  args: { state: "member-draft" },
};
export const AgentDetailCard: Story = {
  name: "Card tab",
  args: { tab: "card" },
};
export const AgentDetailLoading: Story = { args: { state: "loading" } };
export const AgentDetailError: Story = { args: { state: "error" } };
export const AgentDetailDark: Story = {
  name: "Overview (dark)",
  globals: { theme: "dark" },
};
export const AgentDetailMobile: Story = {
  name: "Overview (390px)",
  globals: MOBILE,
};
export const AgentDetailCardMobileDark: Story = {
  name: "Card tab (390px, dark)",
  args: { tab: "card" },
  globals: { ...MOBILE, theme: "dark" },
};

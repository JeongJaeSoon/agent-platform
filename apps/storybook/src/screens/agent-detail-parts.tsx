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
  Link,
  PageHeader,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@werft-ai/ui";
import { ArrowLeft, Check, Copy } from "lucide-react";
import type { ReactNode } from "react";

import { LockedButton, PartRequest } from "./screen-kit.tsx";

/*
 * Console v4 agent detail (Console.dc.html L709-788), shared by the v4 story
 * and the Slack console's detail: the head, the four tabs, the overview and
 * the card tab. Values are the fields GET /v1/agents/{id} returns; what it
 * does not return says so.
 */

export const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

export interface AgentCard {
  readonly role: string;
  readonly instructions: string;
  readonly language: string;
  readonly model: string;
  readonly capabilities: {
    readonly tools: null;
    readonly forbidden: readonly string[];
    readonly mcp: readonly { readonly server: string }[];
    readonly credential_refs: readonly string[];
  };
  readonly rules: readonly string[];
}

export interface AgentView {
  readonly name: string;
  readonly slug: string;
  readonly released: boolean;
  readonly card: AgentCard;
  /** The active release's version, or the latest when none is active. */
  readonly version: string;
  readonly profile: string;
  readonly versionAt: string;
  readonly releases: number;
}

export type AgentTab = "overview" | "card" | "release" | "admins";

const TABS: readonly (readonly [AgentTab, string])[] = [
  ["overview", "개요"],
  ["card", "카드"],
  ["release", "배포"],
  ["admins", "관리자"],
];

function Avatar({ name }: { readonly name: string }) {
  return (
    <div
      aria-hidden="true"
      className="grid size-8 flex-none place-items-center rounded-control bg-active font-semibold text-caption text-muted-foreground"
    >
      {name.slice(0, 2)}
    </div>
  );
}

/**
 * The state badge on the name's line, where the mockup has it; below 768px
 * the actions go under the title, as on a session's page.
 */
export function AgentHead({
  agent,
  backHref,
}: {
  readonly agent: AgentView;
  readonly backHref?: string | undefined;
}) {
  return (
    <PageHeader
      stackBelow="lg"
      title={
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={agent.name} />
          {agent.name}
        </div>
      }
      titleAside={
        <Badge variant={agent.released ? "green" : "gray"}>
          {agent.released ? "활성" : "아직 쓸 수 없음"}
        </Badge>
      }
      description={
        <div className="flex flex-wrap items-center gap-2">
          {agent.card.role}
          <PartRequest name="Avatar" />
        </div>
      }
      actions={
        <>
          <LockedButton
            label="이 에이전트로 새 세션"
            reason="웹에서는 아직 세션을 시작할 수 없습니다. API로 시작하세요."
            size="default"
          />
          <Button asChild variant="outline">
            <a href={backHref ?? "#agents"}>
              <ArrowLeft aria-hidden="true" />
              에이전트 목록
            </a>
          </Button>
        </>
      }
    />
  );
}

/** The detail's tabs; `extra` adds triggers after the four, `children` the panels. */
export function AgentTabs<T extends string>({
  value,
  onValueChange,
  extra,
  children,
}: {
  readonly value: AgentTab | T;
  readonly onValueChange?: ((value: AgentTab | T) => void) | undefined;
  readonly extra?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Tabs
      value={value}
      {...(onValueChange && {
        onValueChange: (next: string) => onValueChange(next as AgentTab | T),
      })}
      className="gap-0"
    >
      <div className="mb-6 border-b">
        <TabsList variant="line" aria-label="에이전트 상세">
          {TABS.map(([key, label]) => (
            <TabsTrigger key={key} value={key}>
              {label}
            </TabsTrigger>
          ))}
          {extra}
        </TabsList>
      </div>
      {children}
    </Tabs>
  );
}

function Figure({
  label,
  value,
  note,
  muted = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly note: string;
  readonly muted?: boolean;
}) {
  return (
    <Card className="h-full gap-3 p-4">
      <CardDescription className="flex items-center gap-2 text-control">
        {label}
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

export function AgentOverview({
  agent,
  className,
}: {
  readonly agent: AgentView;
  readonly className?: string | undefined;
}) {
  const refs = agent.card.capabilities.credential_refs;
  return (
    <div className={cn("@container flex flex-col gap-8", className)}>
      <div className="flex flex-col gap-3">
        <PartRequest name="StatCard" />
        <div className="grid grid-cols-1 gap-4 @[720px]:grid-cols-2">
          <Figure
            label="배포된 버전"
            value={agent.released ? agent.version : "없음"}
            muted={!agent.released}
            note={
              agent.released
                ? `실행 프로필 ${agent.profile}`
                : "아직 켜지지 않았습니다. 배포 탭에서 release를 만들고 활성화하면 새 세션이 이 에이전트를 씁니다."
            }
          />
          <Figure
            label="최신 버전"
            value={agent.version}
            note={
              agent.released
                ? `${agent.versionAt} · 새 세션은 최신 version으로 시작합니다.`
                : `${agent.versionAt} · 아직 배포하지 않았습니다.`
            }
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
              desc:
                refs.length === 0
                  ? "카드가 쓰는 자격 증명이 없습니다."
                  : agent.released
                    ? `필요한 ${refs.length}개를 모두 연결했습니다.`
                    : `연결이 필요합니다: ${refs.join(", ")}`,
              done: agent.released || refs.length === 0,
              action:
                agent.released || refs.length === 0 ? undefined : (
                  <Button variant="outline">배포 탭으로</Button>
                ),
            },
            {
              title: "release 만들기",
              desc: agent.released
                ? `release ${agent.releases}개가 있습니다.`
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
  if (items.length === 0) return "없음";
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

export function AgentCardTab({ agent }: { readonly agent: AgentView }) {
  const { card } = agent;
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
              <Badge className="font-mono font-normal">{agent.version}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent>
            <dl className="m-0 grid grid-cols-1 items-baseline gap-x-4 gap-y-1 text-control sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-y-2">
              <Fact term="이름">{agent.name}</Fact>
              <Fact term="식별자">{agent.slug}</Fact>
              <Fact term="역할">{card.role}</Fact>
              <Fact term="지시 사항">{card.instructions}</Fact>
              <Fact term="모델">{card.model}</Fact>
              <Fact term="언어">한국어</Fact>
              <Fact term="쓸 수 있는 도구">프로필이 허용하는 도구 전부</Fact>
              <Fact term="금지 도구">
                <Names items={card.capabilities.forbidden} />
              </Fact>
              <Fact term="MCP">
                <Names
                  items={card.capabilities.mcp.map((server) => server.server)}
                />
              </Fact>
              <Fact term="자격 증명">
                <Names items={card.capabilities.credential_refs} />
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
              {JSON.stringify(card, null, 2)}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

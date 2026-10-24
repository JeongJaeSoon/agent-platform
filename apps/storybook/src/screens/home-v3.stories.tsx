import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Link, PageHeader, RowList, RowListItem } from "@werft-ai/ui";
import { ArrowRight } from "lucide-react";
import { useId } from "react";

import { MOBILE, ScreenShell } from "./screen-kit.tsx";
import { Heading, MUTED_TEXT, storyHref } from "./slack-kit.tsx";

/*
 * Home's "지금 할 일" (v3-ia.md §3.5) on apps/web home.tsx as main draws it:
 * under the title, above the checklist, three items at most and "전체 보기
 * n건" past that; with nothing to do the section is not there. The sections
 * below it are main's home, unchanged, kept as their headings only.
 */

const DETAIL = "screens-agent-detail-v3--agent-detail";
const LIST = "screens-agent-list-v3--agent-list-slack-mixed";
const SECONDARY = "text-caption text-muted-foreground";

interface Todo {
  readonly title: string;
  readonly sub: string;
  readonly action: "검토" | "고치기";
  readonly story: string;
}

// Order on screen: request, error, second request.
const TODOS: readonly Todo[] = [
  {
    title: "#finance-private 연결 승인 요청",
    sub: "Release Notes · kim.dev가 2026. 10. 23. 15:02에 초대",
    action: "검토",
    story: `${DETAIL}-dialog-review`,
  },
  {
    title: "Slack 이벤트 주소 확인 실패",
    sub: "Release Notes · 멘션을 받지 못하고 있습니다",
    action: "고치기",
    story: `${DETAIL}-slack-error`,
  },
  {
    title: "#ops-private 연결 승인 요청",
    sub: "On-call Helper · lee.ops가 2026. 10. 23. 14:40에 초대",
    action: "검토",
    // Detail stories only draw Release Notes, so other agents' items open
    // the agent list where their rows are.
    story: LIST,
  },
  {
    title: "Slack 홈 채널 미선택",
    sub: "Docs Tidy · 봇이 아직 어느 채널에도 인사하지 않았습니다",
    action: "고치기",
    story: LIST,
  },
];
const SHOWN = 3;
const EXISTING = ["시작하기", "답변 대기", "한눈에 보기", "최근 세션"];

function HomeTodo({ todos }: { readonly todos: readonly Todo[] }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-[var(--ap-space-block)]"
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <Heading id={titleId}>지금 할 일</Heading>
        {todos.length > SHOWN ? (
          <Link
            href={storyHref(LIST)}
            className="inline-flex items-center gap-1 text-control"
          >
            전체 보기 {todos.length}건
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        ) : null}
      </div>
      <RowList variant="joined">
        {todos.slice(0, SHOWN).map((todo) => (
          <RowListItem key={todo.title}>
            <div className="flex min-w-0 flex-1 flex-col gap-[var(--ap-row-line-gap)]">
              <div className="font-semibold leading-5">{todo.title}</div>
              <div className={`${SECONDARY} leading-4`}>{todo.sub}</div>
            </div>
            <Button asChild variant="outline" size="sm">
              <a
                href={storyHref(todo.story)}
                aria-label={`${todo.title} ${todo.action}`}
              >
                {todo.action}
              </a>
            </Button>
          </RowListItem>
        ))}
      </RowList>
    </section>
  );
}

function ExistingSection({ title }: { readonly title: string }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-[var(--ap-space-block)]"
    >
      <div className="flex min-h-7 items-center">
        <Heading id={titleId}>{title}</Heading>
      </div>
      <div className={MUTED_TEXT}>
        지금 홈 그대로입니다. 이 story는 위의 '지금 할 일'만 그립니다.
      </div>
    </section>
  );
}

function HomeScreen({ count }: { readonly count: 0 | 2 | 4 }) {
  return (
    <ScreenShell current="home" crumb={["홈"]}>
      <PageHeader
        title="홈"
        description="설치 전체 현황과 워크스페이스 점검 항목입니다."
        actions={<Button type="button">새 세션</Button>}
      />
      <div className="flex flex-col gap-[var(--ap-space-section)]">
        {count > 0 ? <HomeTodo todos={TODOS.slice(0, count)} /> : null}
        {EXISTING.map((title) => (
          <ExistingSection key={title} title={title} />
        ))}
      </div>
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Home (v3)",
  component: HomeScreen,
  parameters: { layout: "fullscreen" },
  args: { count: 2 },
} satisfies Meta<typeof HomeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

const DARK = { theme: "dark" };

export const HomeTodoSome: Story = { name: "지금 할 일: 2건" };
export const HomeTodoSomeDark: Story = {
  name: "지금 할 일: 2건 (dark)",
  globals: DARK,
};
export const HomeTodoSomeMobile: Story = {
  name: "지금 할 일: 2건 (390px)",
  globals: MOBILE,
};

export const HomeTodoMany: Story = {
  name: "지금 할 일: 넘침 (전체 보기 4건)",
  args: { count: 4 },
};
export const HomeTodoManyDark: Story = {
  ...HomeTodoMany,
  name: "지금 할 일: 넘침 (dark)",
  globals: DARK,
};
export const HomeTodoManyMobile: Story = {
  ...HomeTodoMany,
  name: "지금 할 일: 넘침 (390px)",
  globals: MOBILE,
};

export const HomeTodoNone: Story = {
  name: "지금 할 일: 없음",
  args: { count: 0 },
};
export const HomeTodoNoneDark: Story = {
  ...HomeTodoNone,
  name: "지금 할 일: 없음 (dark)",
  globals: DARK,
};
export const HomeTodoNoneMobile: Story = {
  ...HomeTodoNone,
  name: "지금 할 일: 없음 (390px)",
  globals: MOBILE,
};

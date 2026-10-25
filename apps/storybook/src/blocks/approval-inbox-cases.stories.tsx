import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalInbox } from "@werft-ai/react/blocks";
import { EmptyState, Link as TextLink } from "@werft-ai/ui";
import { expect, userEvent, within } from "storybook/test";

import {
  apiError,
  type FakeRoutes,
  json,
} from "../../.storybook/fake-client.ts";
import { SESSION } from "../domain/session/session-fixtures.ts";
import {
  accepted,
  type Globals,
  hostFor,
  page,
  pending,
  shared,
} from "./block-fixtures.tsx";

/*
 * 94S-939: the inbox's cases as home ("답이 필요한 요청", at most five lines)
 * and the sessions screen ("답변 대기", every line) draw them. Each story
 * takes `host` so the two read side by side.
 */

type Host = "home" | "sessions";
interface Args {
  readonly host: Host;
}

const NOW = Date.parse(SESSION.updated_at) + 12 * 60_000;
const OPEN_UNTIL = "2099-01-01T00:00:00.000Z";

const id = (n: number) =>
  `0192f0c4-7d3a-7b4e-9f00-${n.toString(16).padStart(12, "0")}`;

const AGENT = { id: id(900), name: "문의 분류", release_version_no: 3 };

const question = (n: number, prompt: string) => ({
  kind: "question",
  request_id: `req_q${n}`,
  turn_id: "turn_1",
  attempt_id: "att_1",
  created_at: SESSION.updated_at,
  expires_at: OPEN_UNTIL,
  questions: [
    {
      question_id: "q_1",
      prompt,
      options: [
        { option_id: "en", label: "영어" },
        { option_id: "ja", label: "일본어" },
      ],
      multi_select: false,
      allow_free_text: true,
    },
  ],
});

const permission = (n: number, tool: string, input: unknown) => ({
  kind: "permission",
  request_id: `req_p${n}`,
  turn_id: "turn_1",
  attempt_id: "att_1",
  created_at: SESSION.updated_at,
  expires_at: OPEN_UNTIL,
  tool,
  input,
});

interface Line {
  readonly n: number;
  readonly title: string | null;
  readonly agent?: typeof AGENT | null;
  readonly request: unknown;
}

const LINES: readonly Line[] = [
  {
    n: 1,
    title: "온보딩 문서 번역 범위 확인",
    agent: AGENT,
    request: question(1, "어느 언어로 번역할까요?"),
  },
  {
    n: 2,
    title: "의존성 업데이트 영향 확인",
    request: permission(2, "Bash", { command: "bun update --latest" }),
  },
  {
    n: 3,
    title: null,
    agent: AGENT,
    request: permission(3, "Write", { file_path: "src/billing/notify.ts" }),
  },
  {
    n: 4,
    title: "결제 실패 알림 수정",
    request: question(4, "릴리스 브랜치에도 올릴까요?"),
  },
  {
    n: 5,
    title: "주간 사용량 보고서",
    agent: AGENT,
    request: permission(5, "Edit", { file_path: "reports/weekly.md" }),
  },
  {
    n: 6,
    title: "README 오타 수정",
    request: permission(6, "Bash", { command: "bun run lint" }),
  },
  {
    n: 7,
    title: "로그 보존 기간 조정",
    request: question(7, "보존 기간을 며칠로 할까요?"),
  },
  {
    n: 8,
    title: "지난주 문의 분류",
    agent: AGENT,
    request: permission(8, "Read", { file_path: "inbox/2026-10-18.json" }),
  },
];

const LONG: readonly Line[] = [
  {
    n: 11,
    title:
      "고객 지원 문의 응답 템플릿을 세 언어로 나눠 정리하고 각 언어 담당자에게 검토를 요청하는 세션",
    agent: {
      ...AGENT,
      name: "고객지원-다국어-응답-템플릿-정리-및-검토-요청-에이전트",
    },
    request: question(
      11,
      "결제 실패 알림을 고친 커밋을 어느 브랜치에 올릴까요? 릴리스 브랜치에 올리면 다음 패치 배포에 함께 나가고, main에만 올리면 다음 정기 배포까지 기다립니다.",
    ),
  },
  {
    n: 12,
    title: "깃허브 PR 생성",
    request: permission(12, "mcp__github__create_pull_request_with_reviewers", {
      title: "fix: 결제 실패 알림",
    }),
  },
];

const routes = (lines: readonly Line[]): FakeRoutes => {
  const result: FakeRoutes = {
    "GET /v1/sessions": () =>
      page(
        lines.map((line) => ({
          ...SESSION,
          id: id(line.n),
          title: line.title,
          agent: line.agent ?? null,
          status: "needs_input",
        })),
      ),
  };
  for (const line of lines) {
    result[`GET /v1/sessions/${id(line.n)}/pending-requests`] = () =>
      json(200, { answerable: true, items: [line.request] });
    result[`POST /v1/sessions/${id(line.n)}/answers`] = accepted;
  }
  return result;
};

const render = ({ host }: Args, context: Globals) =>
  host === "home" ? (
    <ApprovalInbox
      renderError={shared(hostFor(context)).renderError}
      layout="summary"
      title="답이 필요한 요청"
      action={<TextLink href="#sessions">전체 보기</TextLink>}
      empty={
        <EmptyState
          title="지금 답할 요청이 없습니다"
          description="세션이 권한이나 답을 기다리면 여기에 먼저 나옵니다."
        />
      }
      now={NOW}
      limit={5}
      more={(count) => (
        <TextLink href="#sessions">다른 세션 {count}개 더 보기</TextLink>
      )}
    />
  ) : (
    <ApprovalInbox
      renderError={shared(hostFor(context)).renderError}
      layout="summary"
      now={NOW}
    />
  );

const meta = {
  title: "Blocks/ApprovalInbox/Cases",
  render,
  args: { host: "home" },
  argTypes: {
    host: { control: "inline-radio", options: ["home", "sessions"] },
  },
} satisfies Meta<Args>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  parameters: { api: { "GET /v1/sessions": pending } },
  play: async ({ canvasElement }) => {
    const rows = canvasElement.querySelectorAll(
      "[data-slot=inbox-skeleton] > div",
    );
    await expect(rows.length).toBe(2);
  },
};

export const Failed: Story = {
  name: "Error",
  parameters: {
    api: {
      "GET /v1/sessions": () =>
        apiError(503, "BACKEND_UNAVAILABLE", "backend unavailable"),
    },
  },
};

export const Empty: Story = {
  parameters: { api: { "GET /v1/sessions": () => page([]) } },
};

export const One: Story = {
  parameters: { api: routes(LINES.slice(0, 1)) },
};

export const Three: Story = {
  parameters: { api: routes(LINES.slice(0, 3)) },
};

/** Home draws five lines and hands the rest to the sessions screen. */
export const Many: Story = {
  parameters: { api: routes(LINES) },
  play: async ({ canvasElement, args }) => {
    const lines = canvasElement.querySelectorAll("section > ul > li");
    // Home: five sessions and the "more" line; sessions: all eight.
    await expect(lines.length).toBe(args.host === "home" ? 6 : 8);
  },
};

export const Long: Story = {
  parameters: { api: routes(LONG) },
};

/**
 * A session the waiting list still names whose own list came back empty, as
 * right after an answer or an expiry: it is left out and not counted, never
 * a line saying nothing waits.
 */
export const Stale: Story = {
  parameters: {
    api: {
      ...routes(LINES.slice(0, 2)),
      "GET /v1/sessions": () =>
        page(
          [1, 2, 9].map((n) => ({
            ...SESSION,
            id: id(n),
            title: LINES.find((line) => line.n === n)?.title ?? null,
            status: "needs_input",
          })),
        ),
      [`GET /v1/sessions/${id(9)}/pending-requests`]: () =>
        json(200, { answerable: true, items: [] }),
    } satisfies FakeRoutes,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("의존성 업데이트 영향 확인");
    await expect(canvas.queryByText(/요청이 없습니다/)).toBeNull();
    await expect(
      canvasElement.querySelectorAll("section > ul > li").length,
    ).toBe(2);
  },
};

/** An answer on its way: the pressed button spins, the line is aria-busy. */
export const Submitting: Story = {
  parameters: {
    api: {
      ...routes(LINES.slice(0, 2)),
      [`POST /v1/sessions/${id(2)}/answers`]: pending,
    } satisfies FakeRoutes,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const allow = await canvas.findByRole("button", { name: /허용: Bash/ });
    await userEvent.click(allow);
    await expect(allow).toBeDisabled();
    await expect(allow.querySelector("[data-slot=busy]")).not.toBeNull();
    await expect(allow.closest("[aria-busy=true]")).not.toBeNull();
  },
};

/** "답하기" opens the question's form under its line, focus on the first choice. */
export const QuestionOpen: Story = {
  parameters: { api: routes(LINES.slice(0, 2)) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = await canvas.findByRole("button", { name: "답하기" });
    await userEvent.click(open);
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await expect(
      await canvas.findByRole("radio", { name: "영어" }),
    ).toHaveFocus();
  },
};

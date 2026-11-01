import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ApiErrorState,
  ApprovalRow,
  type ApprovalRowMessages,
  type PermissionRequest,
  StatusLabel,
} from "@werft-ai/react/components";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
} from "@werft-ai/ui";
import { useId } from "react";

/*
 * One list panel in each state a screen goes through, built only from
 * packages/ui and @werft-ai/react/components. apps/web's StatusScreen is not here: it needs the i18n
 * provider and the router's <Link>, which this workspace does not mount.
 */

type PanelState = "loading" | "empty" | "error" | "ready" | "approvals";

// Demo data: a fixed clock and two requests from two sessions.
const NOW = Date.parse("2026-10-21T01:00:00.000Z");
const REQUESTS: readonly (PermissionRequest & { readonly session: string })[] =
  [
    {
      session: "0192f0c4",
      request_id: "req_1",
      turn_id: "1",
      attempt_id: "att_1",
      kind: "permission",
      tool: "Bash",
      input: { command: "bun test" },
      created_at: "2026-10-21T00:59:00.000Z",
      expires_at: "2026-10-21T01:10:00.000Z",
    },
    {
      session: "819f21a8",
      request_id: "req_2",
      turn_id: "1",
      attempt_id: "att_1",
      kind: "permission",
      tool: "Write",
      input: { file_path: "src/billing/notify.ts" },
      created_at: "2026-10-21T00:58:00.000Z",
      expires_at: "2026-10-21T01:08:00.000Z",
    },
  ];

const approvalMessages = (session: string): ApprovalRowMessages => ({
  title: (tool) => `권한 요청: ${tool}`,
  input: "요청 내용 보기",
  expires: (at) => `${at}까지`,
  expired: "만료되어 더 이상 답할 수 없습니다.",
  allow: "허용",
  deny: "거부",
  allowName: (tool) => `허용: ${tool} · ${session}`,
  denyName: (tool) => `거부: ${tool} · ${session}`,
  denyReason: "거부하는 이유",
  denySubmit: "거부 보내기",
  cancel: "취소",
});

/** The waiting requests above the list, one line each. */
function Approvals() {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="story-stack">
      <h2 id={titleId} className="m-0 font-semibold text-body">
        답변 대기
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {REQUESTS.map(({ session, ...request }) => (
          <li key={request.request_id}>
            <ApprovalRow
              request={request}
              messages={approvalMessages(session)}
              onAllow={() => {}}
              onDeny={() => {}}
              now={NOW}
              subject={
                <a href="#session" className="font-mono text-link underline">
                  <code>{session}…</code>
                </a>
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionsPanel({ state }: { readonly state: PanelState }) {
  if (state === "approvals") {
    return (
      <div className="flex flex-col gap-[var(--ap-space-block)]">
        <Approvals />
        <SessionsPanel state="ready" />
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>세션</CardTitle>
      </CardHeader>
      <CardContent>
        {state === "loading" ? <Skeleton lines={4} label="세션 목록" /> : null}
        {state === "empty" ? (
          <EmptyState
            title="아직 세션이 없습니다"
            description="에이전트에게 첫 지시를 보내면 여기에 쌓입니다."
            action={<Button type="button">새 세션</Button>}
          />
        ) : null}
        {state === "error" ? (
          <ApiErrorState
            message="request timed out"
            code="REQUEST_TIMEOUT"
            retry={() => {}}
          />
        ) : null}
        {state === "ready" ? (
          <ul className="story-stack">
            <li>
              <StatusLabel axis="turn" state="running" detail="2분 12초 경과" />
            </li>
            <li>
              <StatusLabel axis="turn" state="completed" />
            </li>
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

const meta = {
  title: "Screens/Sessions panel",
  component: SessionsPanel,
  args: { state: "loading" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["loading", "empty", "error", "ready", "approvals"],
    },
  },
} satisfies Meta<typeof SessionsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { args: { state: "ready" } };
export const Loading: Story = {};
export const Empty: Story = { args: { state: "empty" } };
export const Failed: Story = { name: "Error", args: { state: "error" } };

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

/** Requests waiting for an answer sit above the list, one line each. */
export const WithApprovals: Story = {
  name: "With approvals",
  args: { state: "approvals" },
};

export const WithApprovalsMobile: Story = {
  name: "With approvals (390px)",
  args: { state: "approvals" },
  globals: MOBILE,
};

export const WithApprovalsDark: Story = {
  name: "With approvals (dark)",
  args: { state: "approvals" },
  globals: { theme: "dark" },
};

export const EmptyMobile: Story = {
  name: "Empty (390px)",
  args: { state: "empty" },
  globals: MOBILE,
};

export const ErrorMobileDark: Story = {
  name: "Error (390px, dark)",
  args: { state: "error" },
  globals: { ...MOBILE, theme: "dark" },
};

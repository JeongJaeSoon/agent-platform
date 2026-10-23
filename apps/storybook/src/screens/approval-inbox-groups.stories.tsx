import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ApprovalCard,
  type ApprovalCardMessages,
  type PermissionRequest,
} from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  formatTimestamp,
  Link,
} from "@werft-ai/ui";

/*
 * S-A5: the approval inbox shows one turn's sibling requests as a group.
 * ApprovalInbox lives in @werft-ai/react/blocks, so the group is composed
 * from ApprovalCard rows here.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type GroupState = "waiting" | "parked" | "empty";

const NOW = Date.parse("2026-10-21T01:00:00.000Z");
const EXPIRES_AT = "2026-10-22T01:00:00.000Z";
const PARK_AT = formatTimestamp("2026-10-21T01:30:00.000Z", "ko");
const SESSION_ID = "819f21a8-2c1e-4f0b-9a3d-000000000b07";

const REQUESTS: readonly PermissionRequest[] = [
  {
    request_id: "req_group_01",
    turn_id: "turn_07",
    attempt_id: "att_01",
    kind: "permission",
    tool: "Bash",
    input: { command: "bun run deploy --dry-run" },
    created_at: "2026-10-21T00:59:00.000Z",
    expires_at: EXPIRES_AT,
  },
  {
    request_id: "req_group_02",
    turn_id: "turn_07",
    attempt_id: "att_01",
    kind: "permission",
    tool: "Edit",
    input: { file_path: "CHANGELOG.md" },
    created_at: "2026-10-21T00:59:02.000Z",
    expires_at: EXPIRES_AT,
  },
];

const MESSAGES: Omit<ApprovalCardMessages, "expires"> = {
  title: (tool) => `권한 요청: ${tool}`,
  input: "요청 내용 보기",
  expired: "만료되어 더 이상 답할 수 없습니다.",
  allow: "허용",
  deny: "거부",
  denyReason: "거부하는 이유",
  denySubmit: "거부 보내기",
  cancel: "취소",
};

function ApprovalInboxGroupsBody({ state }: { readonly state: GroupState }) {
  if (state === "empty") {
    return (
      <EmptyState
        title="기다리는 요청 없음"
        description="답을 기다리는 요청이 없습니다."
        action={<Button type="button">세션 목록</Button>}
      />
    );
  }
  const parked = state === "parked";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          요청 {REQUESTS.length}개 · 모두 답하면 이어서 진행
        </CardTitle>
        {parked ? (
          <CardAction>
            <Badge variant="amber">일시정지됨</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="story-stack">
        {REQUESTS.map((request) => (
          <ApprovalCard
            key={request.request_id}
            request={request}
            now={NOW}
            onAllow={() => {}}
            onDeny={() => {}}
            subject={
              <Link href={`#/sessions/${SESSION_ID}`} className="font-mono">
                {SESSION_ID.slice(0, 8)} <span aria-hidden="true">›</span>
              </Link>
            }
            messages={{
              ...MESSAGES,
              expires: parked
                ? (at) =>
                    `${at}까지 답할 수 있습니다. 답하면 작업을 다시 띄웁니다(1분 안팎 걸립니다).`
                : (at) =>
                    `${PARK_AT}까지 답이 없으면 일시정지합니다 · ${at}까지 답할 수 있습니다`,
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ApprovalInboxGroupsScreen(
  props: Parameters<typeof ApprovalInboxGroupsBody>[0],
) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <ApprovalInboxGroupsBody {...props} />
    </div>
  );
}

const meta = {
  title: "Screens/Approval inbox groups (v3)",
  component: ApprovalInboxGroupsScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "waiting" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["waiting", "parked", "empty"],
    },
  },
} satisfies Meta<typeof ApprovalInboxGroupsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ApprovalInboxGroups: Story = { name: "Waiting group" };
export const ApprovalInboxGroupsParked: Story = {
  name: "Parked group",
  args: { state: "parked" },
};
export const ApprovalInboxGroupsEmpty: Story = {
  name: "Empty",
  args: { state: "empty" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const ApprovalInboxGroupsParkedMobile: Story = {
  name: "Parked group (390px)",
  args: { state: "parked" },
  globals: MOBILE,
};

export const ApprovalInboxGroupsParkedMobileDark: Story = {
  name: "Parked group (390px, dark)",
  args: { state: "parked" },
  globals: { ...MOBILE, theme: "dark" },
};

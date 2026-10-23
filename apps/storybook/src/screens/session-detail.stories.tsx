import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TurnEventMessage } from "@werft-ai/contracts";
import {
  ApprovalCard,
  Composer,
  type PermissionRequest,
  SessionStatusLabel,
  Timeline,
} from "@werft-ai/react/components";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  PageHeader,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@werft-ai/ui";
import type { ReactNode } from "react";

import {
  formatMessage as formatEnglish,
  TURN_EVENTS,
  timelineEntries,
} from "../domain/session/session-fixtures.ts";
import {
  DangerArea,
  LockedButton,
  MOBILE,
  PartRequest,
  ScreenShell,
} from "./screen-kit.tsx";

/*
 * v3 session detail (.design/v3-members/plan.md §9 D-01..D-07). The real
 * screen's parts stay (ApprovalCard, Timeline, Composer); new are who may
 * answer and the owner/admin 운영 조치, in two placements to choose from.
 * Sessions have no name in the API, so the title is the short id with the
 * profile and repository beside it.
 */

const SID = "5a2d244a-7897-4ff3-83c3-2da21363689c";
const NOW = Date.parse("2026-10-23T14:01:00.000Z");

const KO: Partial<Record<TurnEventMessage["key"], string>> = {
  "sessions.status.running": "작업 중",
  "sessions.status.needs_input": "답변 대기",
  "session.event.kind.status": "상태",
  "session.event.kind.system": "시스템",
  "session.event.kind.toolUse": "도구 호출",
  "session.event.kind.toolResult": "도구 결과",
  "session.event.kind.assistant": "답변",
  "session.event.kind.thinking": "생각",
  "session.event.kind.permission": "권한 요청",
  "session.event.kind.result": "turn 끝",
  "session.event.init": "세션 시작",
  "session.event.toolResult": "{tool} 결과",
  "session.event.toolResult.ok": "성공",
  "session.event.result.success": "turn 완료",
};

function formatMessage(message: TurnEventMessage): string {
  const ko = KO[message.key];
  return ko
    ? ko.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(message.params?.[name] ?? ""),
      )
    : formatEnglish(message);
}

const TIMELINE_MESSAGES = {
  label: "세션 이벤트",
  empty: "아직 이벤트가 없습니다.",
  connecting: "연결하는 중…",
  closed: "연결이 끊겼습니다. 지금까지의 이벤트입니다.",
  turn: (turnId: string) => `turn ${turnId.replace("turn_0", "")}`,
};

const REQUEST: PermissionRequest = {
  request_id: "req_1",
  turn_id: "1",
  attempt_id: "att_1",
  kind: "permission",
  tool: "Bash",
  input: { command: "echo alpha > hello.txt", description: "write hello.txt" },
  created_at: "2026-10-23T14:00:00.000Z",
  expires_at: "2026-10-23T14:31:00.000Z",
};

const APPROVAL_MESSAGES = {
  title: (tool: string) => `권한 요청: ${tool}`,
  input: "요청 내용 보기",
  expires: (at: string) => `${at}까지`,
  expired: "요청이 만료됐습니다.",
  allow: "허용",
  deny: "거부",
  denyReason: "거부하는 이유",
  denySubmit: "거부",
  cancel: "취소",
};

type Viewer = "owner" | "viewer";
type Option = 1 | 2;

function Header({ named = false }: { readonly named?: boolean }) {
  return (
    <PageHeader
      title={
        named ? (
          <>
            결제 알림 고치기{" "}
            <span className="font-mono font-normal text-muted-foreground">
              {SID.slice(0, 8)}
            </span>{" "}
            <Badge variant="red">API 변경 필요</Badge>
          </>
        ) : (
          SID.slice(0, 8)
        )
      }
      description={
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <SessionStatusLabel status="needs_input" label="답변 대기" />
          <span>general · claude-sonnet-5</span>
          <span>verify/hello</span>
          <span>claude_agent_sdk 0.3.270</span>
          <span>진행 중인 작업: 1</span>
          <span>마지막 변경: 2026. 10. 23. 23:01</span>
        </span>
      }
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            aria-label="세션 id 전체 복사"
          >
            id 복사
          </Button>
          <Button asChild variant="ghost">
            <a href="#sessions">← 세션 목록</a>
          </Button>
        </>
      }
    />
  );
}

function Approval({ viewer }: { readonly viewer: Viewer }) {
  return (
    <>
      {viewer === "viewer" ? (
        <PartRequest name="ApprovalCard 잠금 상태(이유·aria-describedby)" />
      ) : null}
      <ApprovalCard
        request={REQUEST}
        messages={APPROVAL_MESSAGES}
        onAllow={() => {}}
        onDeny={() => {}}
        disabled={viewer === "viewer"}
        now={NOW}
        locale="ko"
      />
    </>
  );
}

const VIEWER_REASON =
  "공유받아 볼 수만 있습니다. 시작한 사람·에이전트 관리자·소유자·관리자가 답합니다.";

function Answerers({ viewer }: { readonly viewer: Viewer }) {
  const rows: readonly (readonly [string, string])[] =
    viewer === "owner"
      ? [
          ["시작한 사람", "Verify Owner"],
          ["에이전트 관리자", "이 에이전트의 관리자"],
          ["소유자·관리자", "Verify Owner · Verify Dana"],
        ]
      : [
          ["시작한 사람", "이 세션을 시작한 사람"],
          ["에이전트 관리자", "이 에이전트의 관리자"],
          ["소유자·관리자", "워크스페이스 소유자·관리자"],
        ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>답할 수 있는 사람</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <PartRequest name="KeyValueList" />
        <dl className="m-0 flex flex-col gap-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="m-0 text-right">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 pt-2">
          {viewer === "owner"
            ? "나는 이 요청에 답할 수 있습니다."
            : VIEWER_REASON}
        </p>
      </CardContent>
    </Card>
  );
}

function AnswerersInline({ viewer }: { readonly viewer: Viewer }) {
  return (
    <p className="m-0 text-caption text-muted-foreground">
      답할 수 있는 사람: 시작한 사람 · 에이전트 관리자 · 소유자·관리자 —{" "}
      {viewer === "owner" ? "나는 답할 수 있음" : "나는 볼 수만 있음"}
    </p>
  );
}

function Usage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>사용량</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">누적 비용</span>
          <span>$0.000042 (진행 중 turn 미확정)</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-muted-foreground">토큰</span>
          <span>5</span>
        </div>
      </CardContent>
    </Card>
  );
}

function Control({ viewer }: { readonly viewer: Viewer }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>세션 제어</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {viewer === "viewer" ? (
          <p className="m-0 text-muted-foreground">
            시작한 사람과 관리자만 세션을 제어합니다.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline">
                지금 turn 멈추기
              </Button>
              <Button type="button" variant="outline">
                일시 정지
              </Button>
            </div>
            <Field>
              <FieldLabel>다음 작업부터 쓸 프로필</FieldLabel>
              <NativeSelect defaultValue="general">
                <NativeSelectOption value="general">
                  general · claude-sonnet-5
                </NativeSelectOption>
              </NativeSelect>
              <FieldDescription>
                진행 중인 작업은 지금 프로필로 끝나고, 다음 작업부터 새 프로필로
                이어 갑니다.
              </FieldDescription>
            </Field>
            <Button type="button" variant="outline" className="self-start">
              프로필 바꾸기
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** 세션 종료 leaves the control row (D-07); 운영 조치 is owner/admin only (D-06). */
function Danger({
  takeoverWaiting = false,
}: {
  readonly takeoverWaiting?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {takeoverWaiting ? null : <PartRequest name="LockedButton+Tooltip" />}
      <DangerArea
        rows={[
          {
            title: "세션 종료",
            body: "진행 중인 작업을 끝내고 세션을 닫습니다. 되돌릴 수 없습니다.",
            action: "세션 종료",
          },
          {
            title: "운영 조치 (소유자·관리자)",
            body: "사유를 남기고 관리 종료하거나 이 세션을 이어받습니다. 사유는 감사 기록에 남습니다.",
            action: (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline">
                  관리 종료
                </Button>
                {takeoverWaiting ? (
                  <Button type="button" variant="outline">
                    인계받기
                  </Button>
                ) : (
                  <LockedButton
                    size="default"
                    label="인계받기"
                    reason="인계 대기 상태일 때만 인계받을 수 있습니다."
                  />
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function Progress() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <Tabs value="progress">
          <TabsList variant="line" aria-label="세션 보기">
            <TabsTrigger value="progress">진행</TabsTrigger>
            <TabsTrigger value="info">정보</TabsTrigger>
          </TabsList>
        </Tabs>
        <Field orientation="horizontal" className="w-auto">
          <Checkbox />
          <FieldLabel>내부 이벤트도 보기</FieldLabel>
        </Field>
      </div>
      <Timeline
        entries={timelineEntries(TURN_EVENTS)}
        formatMessage={formatMessage}
        messages={TIMELINE_MESSAGES}
        locale="ko"
      />
      <Composer
        messages={{
          label: "다음 지시",
          send: "보내기",
          hint: "Ctrl+Enter(⌘+Enter)로도 보냅니다. 지금 turn이 끝나면 다음 turn으로 이어집니다.",
          queued: "지금 turn 뒤에 보냄",
        }}
        onSend={() => {}}
      />
    </div>
  );
}

function Info({ viewer }: { readonly viewer: Viewer }) {
  return (
    <div className="flex flex-col gap-4">
      <Tabs value="info">
        <TabsList variant="line" aria-label="세션 보기">
          <TabsTrigger value="progress">진행</TabsTrigger>
          <TabsTrigger value="info">정보</TabsTrigger>
        </TabsList>
      </Tabs>
      <Card>
        <CardContent className="flex flex-col gap-2">
          {[
            ["세션 id", SID],
            ["저장소", "verify/hello"],
            ["런타임", "claude_agent_sdk 0.3.270"],
            ["만든 때", "2026. 10. 23. 23:01"],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <span className="shrink-0 text-muted-foreground">{label}</span>
              <span className="min-w-0 truncate text-right" title={value}>
                {value}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      {viewer === "owner" ? <Danger /> : null}
    </div>
  );
}

const REASON_DIALOG = {
  terminate: {
    title: "이 세션을 관리 종료할까요?",
    body: "진행 중인 작업을 끝내고 세션을 닫습니다. 시작한 사람에게 사유가 보이고 감사 기록에 남습니다.",
    sample: "권한 요청이 30분 넘게 답 없이 멈춰 있어 종료합니다.",
    confirm: "관리 종료",
  },
  takeover: {
    title: "이 세션을 이어받을까요?",
    body: "인계 대기 중인 세션을 내가 이어받습니다. 사유는 감사 기록에 남습니다.",
    sample: "시작한 사람이 퇴사해 운영팀이 이어받습니다.",
    confirm: "인계받기",
  },
} as const;

/** Both admin actions send a `justification` (terminate, takeover). */
function ReasonDialog({ kind }: { readonly kind: keyof typeof REASON_DIALOG }) {
  const copy = REASON_DIALOG[kind];
  return (
    <Dialog open>
      <DialogContent role="alertdialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel>사유</FieldLabel>
          <Textarea required maxLength={500} defaultValue={copy.sample} />
          <FieldDescription>필수. 500자까지.</FieldDescription>
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline">
            취소
          </Button>
          <Button
            type="button"
            variant={kind === "terminate" ? "destructive" : "default"}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SessionDetailScreen({
  option,
  viewer,
  tab = "progress",
  named = false,
  dialog,
  takeoverWaiting = false,
}: {
  readonly option: Option;
  readonly viewer: Viewer;
  readonly tab?: "progress" | "info";
  readonly named?: boolean;
  readonly dialog?: keyof typeof REASON_DIALOG;
  readonly takeoverWaiting?: boolean;
}) {
  let aside: ReactNode;
  if (option === 1) {
    aside = (
      <>
        <Approval viewer={viewer} />
        <Answerers viewer={viewer} />
        <Usage />
        <Control viewer={viewer} />
        {viewer === "owner" ? (
          <Danger takeoverWaiting={takeoverWaiting} />
        ) : null}
      </>
    );
  } else {
    aside = (
      <>
        <div className="flex flex-col gap-2">
          <Approval viewer={viewer} />
          <AnswerersInline viewer={viewer} />
        </div>
        <Usage />
        <Control viewer={viewer} />
      </>
    );
  }
  return (
    <ScreenShell
      current="sessions"
      crumb={["세션", SID.slice(0, 8)]}
      role={viewer === "owner" ? "owner" : "member"}
    >
      <Header named={named} />
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="order-2 flex min-w-0 flex-col gap-4 md:order-1">
          {tab === "info" ? <Info viewer={viewer} /> : <Progress />}
        </div>
        <aside
          aria-label="세션 패널"
          className="order-1 flex min-w-0 flex-col gap-4 md:order-2"
        >
          {aside}
        </aside>
      </div>
      {dialog ? <ReasonDialog kind={dialog} /> : null}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Session detail (v3)",
  component: SessionDetailScreen,
  parameters: { layout: "fullscreen" },
  args: { option: 1, viewer: "owner" },
} satisfies Meta<typeof SessionDetailScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 안 1 (추천): who may answer under the request, danger area at the bottom. */
export const Option1: Story = { name: "안 1: 오른쪽 패널 (추천)" };
export const Option1Viewer: Story = {
  name: "안 1: 공유받아 보기만 (answerable=false)",
  args: { viewer: "viewer" },
};
export const Option1TakeoverWaiting: Story = {
  name: "안 1: 인계 대기 중 (takeover_required_at)",
  args: { takeoverWaiting: true },
};
export const Option1Terminate: Story = {
  name: "안 1: 관리 종료 사유",
  args: { dialog: "terminate" },
};
export const Option1Takeover: Story = {
  name: "안 1: 인계 사유",
  args: { takeoverWaiting: true, dialog: "takeover" },
};
export const Option2: Story = {
  name: "안 2: 요청 카드 아래 한 줄",
  args: { option: 2 },
};
export const Option2Info: Story = {
  name: "안 2: 정보 탭 아래 위험 영역",
  args: { option: 2, tab: "info" },
};
export const NamedAlternative: Story = {
  name: "대안: 세션 이름이 생기면 (API 변경 필요)",
  args: { named: true },
};
export const Option1Dark: Story = {
  name: "안 1 (dark)",
  globals: { theme: "dark" },
};
export const Option1Mobile: Story = {
  name: "안 1 (390px)",
  globals: MOBILE,
};
export const Option1ViewerMobileDark: Story = {
  name: "안 1: 보기만 (390px, dark)",
  args: { viewer: "viewer" },
  globals: { ...MOBILE, theme: "dark" },
};

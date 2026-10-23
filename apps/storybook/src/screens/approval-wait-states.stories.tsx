import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ApprovalCard,
  type PermissionRequest,
  QuestionCard,
  type QuestionRequest,
} from "@werft-ai/react/components";
import { Badge, formatTimestamp } from "@werft-ai/ui";

/*
 * S-A1 (approval card) and S-A2 (question card) through each stage of a
 * request that waits, parks and resumes (design-await-timeout §10.4). The
 * stage's headline rides on the title line, its detail on the expiry line.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type CardKind = "approval" | "question";
type Stage =
  | "waiting"
  | "parking"
  | "parked"
  | "answeredSiblings"
  | "resuming"
  | "allowedResume"
  | "expiredWaiting"
  | "expiredParked"
  | "expiredParkedAnswered"
  | "recoveryRequired"
  | "checkpointUnavailable"
  | "requestExpired"
  | "lost";

// A fixed clock: the group may be answered for 24 hours.
const NOW = Date.parse("2026-10-21T01:00:00.000Z");
const EXPIRES_AT = "2026-10-22T01:00:00.000Z";
const AFTER_EXPIRY = Date.parse("2026-10-22T01:00:01.000Z");
const PARK_AT = formatTimestamp("2026-10-21T01:30:00.000Z", "ko");

type Tone = "gray" | "blue" | "amber" | "red";

interface StageCopy {
  readonly head?: { readonly label: string; readonly tone: Tone };
  readonly detail?: (at: string) => string;
  readonly expired?: string;
  readonly error?: string;
  readonly answered?: boolean;
  readonly lapsed?: boolean;
}

const EXISTING_EXPIRES = (at: string) => `${at}까지`;
const EXISTING_EXPIRED = "만료되어 더 이상 답할 수 없습니다.";
const PARKED = {
  label: "일시정지됨 · 답하면 이어서 진행",
  tone: "amber",
} as const;
const PARKED_DETAIL = (at: string) =>
  `${at}까지 답할 수 있습니다. 답하면 작업을 다시 띄웁니다(1분 안팎 걸립니다).`;

const STAGES: Record<Stage, StageCopy> = {
  waiting: {
    detail: (at) =>
      `${PARK_AT}까지 답이 없으면 일시정지합니다 · ${at}까지 답할 수 있습니다`,
  },
  parking: {
    head: { label: "일시정지하는 중", tone: "amber" },
    detail: () =>
      "지금 답해도 됩니다. 답이 먼저 닿으면 일시정지하지 않고 바로 이어갑니다.",
  },
  parked: { head: PARKED, detail: PARKED_DETAIL },
  answeredSiblings: {
    head: { label: "답을 저장했습니다", tone: "blue" },
    detail: (at) =>
      `나머지 요청 2개에 답하면 이어서 진행합니다. ${at}까지 답이 없으면 답한 것만으로 이어갑니다.`,
    answered: true,
  },
  resuming: {
    head: { label: "이어서 진행하는 중", tone: "blue" },
    answered: true,
  },
  allowedResume: {
    head: { label: "이어서 진행하는 중", tone: "blue" },
    detail: () =>
      "이어서 진행할 때 같은 호출을 한 번 허용합니다. 내용이 바뀌면 다시 묻습니다.",
    answered: true,
  },
  expiredWaiting: {
    expired: `${EXISTING_EXPIRED} 답이 없어 거부했습니다. 작업은 거부를 받고 계속 진행했습니다.`,
    lapsed: true,
  },
  expiredParked: {
    head: { label: "만료됨", tone: "gray" },
    expired: "답이 없어 거부했습니다. 세션은 일시정지 상태로 남아 있습니다.",
    lapsed: true,
  },
  expiredParkedAnswered: {
    head: { label: "만료됨", tone: "gray" },
    expired: "답이 없어 이 요청은 거부했습니다. 답한 내용을 반영해 이어갑니다.",
    lapsed: true,
  },
  recoveryRequired: {
    head: PARKED,
    detail: PARKED_DETAIL,
    error:
      "세션을 복구해야 해서 답을 저장하지 못했습니다. 세션 화면에서 복구를 먼저 진행하세요.",
  },
  checkpointUnavailable: {
    head: PARKED,
    detail: PARKED_DETAIL,
    error:
      "저장된 작업 상태를 찾지 못해 이어갈 수 없습니다. 답을 저장하지 않았습니다.",
  },
  requestExpired: {
    head: PARKED,
    detail: PARKED_DETAIL,
    error: "이미 답했거나 만료되었거나 닫힌 요청입니다.",
  },
  lost: {
    head: { label: "요청이 사라졌습니다", tone: "red" },
    expired: "작업이 중간에 멈춰 이 요청에는 더 답할 수 없습니다.",
    lapsed: true,
  },
};

const PERMISSION: PermissionRequest = {
  request_id: "req_wait_01",
  turn_id: "turn_07",
  attempt_id: "att_01",
  kind: "permission",
  tool: "Bash",
  input: { command: "bun run deploy --dry-run", description: "Dry-run deploy" },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: EXPIRES_AT,
};

const QUESTION: QuestionRequest = {
  request_id: "req_wait_02",
  turn_id: "turn_07",
  attempt_id: "att_01",
  kind: "question",
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: EXPIRES_AT,
  questions: [
    {
      question_id: "q_target",
      prompt: "어느 환경에 먼저 배포할까요?",
      options: [
        { option_id: "staging", label: "staging" },
        { option_id: "production", label: "production" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
  ],
};

function WaitStatesBody({
  card,
  state,
}: {
  readonly card: CardKind;
  readonly state: Stage;
}) {
  const stage = STAGES[state];
  const shared = {
    now: stage.lapsed ? AFTER_EXPIRY : NOW,
    disabled: stage.answered,
    error: stage.error,
  };
  const expires = stage.detail ?? EXISTING_EXPIRES;
  const expired = stage.expired ?? EXISTING_EXPIRED;
  if (card === "question") {
    return (
      <QuestionCard
        {...shared}
        request={QUESTION}
        onSubmit={() => {}}
        messages={{
          title: stage.head ? `질문 · ${stage.head.label}` : "질문",
          expires,
          expired,
          freeText: "직접 적기",
          unanswered: "하나를 고르거나 답을 적어 주세요.",
          submit: "답 보내기",
        }}
      />
    );
  }
  return (
    <ApprovalCard
      {...shared}
      request={PERMISSION}
      onAllow={() => {}}
      onDeny={() => {}}
      subject={
        stage.head ? (
          <Badge variant={stage.head.tone}>{stage.head.label}</Badge>
        ) : undefined
      }
      messages={{
        title: (tool) => `권한 요청: ${tool}`,
        input: "요청 내용 보기",
        expires,
        expired,
        allow: "허용",
        deny: "거부",
        denyReason: "거부하는 이유",
        denySubmit: "거부 보내기",
        cancel: "취소",
      }}
    />
  );
}

function WaitStates(props: Parameters<typeof WaitStatesBody>[0]) {
  return (
    <div className="story-stack">
      {API_CHANGE}
      <WaitStatesBody {...props} />
    </div>
  );
}

const meta = {
  title: "Screens/Approval wait states (v3)",
  component: WaitStates,
  parameters: { layout: "fullscreen" },
  args: { card: "approval", state: "waiting" },
  argTypes: {
    card: { control: "inline-radio", options: ["approval", "question"] },
    state: {
      control: "inline-radio",
      options: Object.keys(STAGES),
    },
  },
} satisfies Meta<typeof WaitStates>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ApprovalWaiting: Story = { name: "Approval · waiting" };
export const ApprovalParking: Story = {
  name: "Approval · parking",
  args: { state: "parking" },
};
export const ApprovalParked: Story = {
  name: "Approval · parked",
  args: { state: "parked" },
};
export const ApprovalAnsweredSiblings: Story = {
  name: "Approval · answered, siblings left",
  args: { state: "answeredSiblings" },
};
export const ApprovalResuming: Story = {
  name: "Approval · resuming",
  args: { state: "resuming" },
};
export const ApprovalAllowedResume: Story = {
  name: "Approval · resuming after allow",
  args: { state: "allowedResume" },
};
export const ApprovalExpiredWaiting: Story = {
  name: "Approval · expired while waiting",
  args: { state: "expiredWaiting" },
};
export const ApprovalExpiredParked: Story = {
  name: "Approval · expired while parked, no answer",
  args: { state: "expiredParked" },
};
export const ApprovalExpiredParkedAnswered: Story = {
  name: "Approval · expired while parked, group answered",
  args: { state: "expiredParkedAnswered" },
};
export const ApprovalRecoveryRequired: Story = {
  name: "Approval · 409 RECOVERY_REQUIRED",
  args: { state: "recoveryRequired" },
};
export const ApprovalCheckpointUnavailable: Story = {
  name: "Approval · 409 CHECKPOINT_UNAVAILABLE",
  args: { state: "checkpointUnavailable" },
};
export const ApprovalRequestExpired: Story = {
  name: "Approval · 409 REQUEST_EXPIRED",
  args: { state: "requestExpired" },
};
export const ApprovalLost: Story = {
  name: "Approval · lost",
  args: { state: "lost" },
};

const QUESTION_ARGS = { card: "question" } as const;

export const QuestionWaiting: Story = {
  name: "Question · waiting",
  args: { ...QUESTION_ARGS },
};
export const QuestionParking: Story = {
  name: "Question · parking",
  args: { ...QUESTION_ARGS, state: "parking" },
};
export const QuestionParked: Story = {
  name: "Question · parked",
  args: { ...QUESTION_ARGS, state: "parked" },
};
export const QuestionAnsweredSiblings: Story = {
  name: "Question · answered, siblings left",
  args: { ...QUESTION_ARGS, state: "answeredSiblings" },
};
export const QuestionResuming: Story = {
  name: "Question · resuming",
  args: { ...QUESTION_ARGS, state: "resuming" },
};
export const QuestionExpiredWaiting: Story = {
  name: "Question · expired while waiting",
  args: { ...QUESTION_ARGS, state: "expiredWaiting" },
};
export const QuestionExpiredParked: Story = {
  name: "Question · expired while parked, no answer",
  args: { ...QUESTION_ARGS, state: "expiredParked" },
};
export const QuestionExpiredParkedAnswered: Story = {
  name: "Question · expired while parked, group answered",
  args: { ...QUESTION_ARGS, state: "expiredParkedAnswered" },
};
export const QuestionRecoveryRequired: Story = {
  name: "Question · 409 RECOVERY_REQUIRED",
  args: { ...QUESTION_ARGS, state: "recoveryRequired" },
};
export const QuestionCheckpointUnavailable: Story = {
  name: "Question · 409 CHECKPOINT_UNAVAILABLE",
  args: { ...QUESTION_ARGS, state: "checkpointUnavailable" },
};
export const QuestionRequestExpired: Story = {
  name: "Question · 409 REQUEST_EXPIRED",
  args: { ...QUESTION_ARGS, state: "requestExpired" },
};
export const QuestionLost: Story = {
  name: "Question · lost",
  args: { ...QUESTION_ARGS, state: "lost" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const ApprovalParkedMobile: Story = {
  name: "Approval · parked (390px)",
  args: { state: "parked" },
  globals: MOBILE,
};

export const ApprovalParkedMobileDark: Story = {
  name: "Approval · parked (390px, dark)",
  args: { state: "parked" },
  globals: { ...MOBILE, theme: "dark" },
};

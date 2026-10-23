import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  RadioGroup,
  RadioGroupItem,
} from "@werft-ai/ui";
import { type ReactNode, useState } from "react";

/*
 * S-E3: which agents may receive a workspace variable. The dialog's
 * description is the notice about who ends up using the value.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type Choice = "selected" | "all";
type GrantState = Choice | "saved";

type Tone = "info" | "warning" | "danger";
const TONE = {
  info: { variant: "blue", label: "안내" },
  warning: { variant: "amber", label: "주의" },
  danger: { variant: "red", label: "오류" },
} as const;

// Stands in for the Alert part ui-kit accepted and packages/ui lacks yet.
function AlertStandIn({
  tone,
  role,
  children,
}: {
  readonly tone: Tone;
  readonly role?: "status";
  readonly children: ReactNode;
}) {
  return (
    <Card data-tone={tone} role={role}>
      <CardHeader>
        <CardDescription className="flex items-start gap-2">
          <Badge variant={TONE[tone].variant}>{TONE[tone].label}</Badge>
          <span>{children}</span>
        </CardDescription>
        <CardAction>
          <Badge variant="amber" data-part-request="Alert">
            부품 요청 중: Alert
          </Badge>
        </CardAction>
      </CardHeader>
    </Card>
  );
}

const AGENTS = [
  { id: "agt_pay", name: "결제 담당", declares: true, granted: true },
  { id: "agt_notes", name: "릴리스 노트 작성", declares: true, granted: true },
  { id: "agt_docs", name: "문서 정리", declares: false, granted: false },
];

function GrantDialog({ initial }: { readonly initial: Choice }) {
  const [choice, setChoice] = useState<Choice>(initial);
  const title = "API_BASE_URL을 받을 에이전트";
  return (
    <ConfirmDialog
      open={true}
      onOpenChange={() => {}}
      onConfirm={() => {}}
      title={title}
      consequence="허락한 에이전트로 세션을 시작할 수 있는 사람은 모두 이 값을 쓰게 됩니다. 에이전트 API key와 Slack 손님 세션도 포함됩니다."
      confirmLabel="저장"
    >
      <FieldGroup>
        {API_CHANGE}
        <RadioGroup
          aria-label={title}
          value={choice}
          onValueChange={(value) => setChoice(value as Choice)}
          className="gap-2"
        >
          <Field orientation="horizontal">
            <RadioGroupItem value="selected" />
            <FieldLabel>선택한 에이전트만</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem value="all" />
            <FieldLabel>모든 에이전트</FieldLabel>
          </Field>
        </RadioGroup>
        {choice === "all" ? (
          <AlertStandIn tone="warning">
            모든 에이전트를 고르면 사실상 모든 멤버가 이 값을 쓸 수 있습니다.
            멤버가 새로 만든 에이전트와 무인 모드로 도는 세션도 포함됩니다.
          </AlertStandIn>
        ) : (
          <ul className="story-stack">
            {AGENTS.map((agent) => (
              <li key={agent.id}>
                <Field orientation="horizontal">
                  <Checkbox defaultChecked={agent.granted} />
                  <FieldContent>
                    <FieldLabel>{agent.name}</FieldLabel>
                    <FieldDescription>
                      {agent.declares
                        ? "이 이름을 선언함"
                        : "선언하지 않음(허락해도 받지 않음)"}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </li>
            ))}
          </ul>
        )}
      </FieldGroup>
    </ConfirmDialog>
  );
}

function VariableGrantDialogScreen({ state }: { readonly state: GrantState }) {
  if (state === "saved") {
    return (
      <div className="story-stack">
        {API_CHANGE}
        <AlertStandIn tone="info" role="status">
          허락을 저장했습니다. 다음 세션부터 반영됩니다.
        </AlertStandIn>
      </div>
    );
  }
  // Keyed so a changed story arg starts the selection over.
  return <GrantDialog key={state} initial={state} />;
}

const meta = {
  title: "Screens/Variable grant dialog (v3)",
  component: VariableGrantDialogScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "selected" },
  argTypes: {
    state: { control: "inline-radio", options: ["selected", "all", "saved"] },
  },
} satisfies Meta<typeof VariableGrantDialogScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VariableGrantDialog: Story = { name: "Selected agents" };
export const VariableGrantDialogAllAgents: Story = {
  name: "All agents warning",
  args: { state: "all" },
};
export const VariableGrantDialogSaved: Story = {
  name: "Saved",
  args: { state: "saved" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const VariableGrantDialogAllAgentsMobile: Story = {
  name: "All agents warning (390px)",
  args: { state: "all" },
  globals: MOBILE,
};

export const VariableGrantDialogAllAgentsMobileDark: Story = {
  name: "All agents warning (390px, dark)",
  args: { state: "all" },
  globals: { ...MOBILE, theme: "dark" },
};

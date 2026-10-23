import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  ConfirmDialog,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Textarea,
} from "@werft-ai/ui";

/*
 * S-E2: adding or editing a variable, from the workspace section (S-E1) or
 * an agent's detail (S-E4). The value notice stays visible in every state.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type EditorState =
  | "new"
  | "edit"
  | "nameFormat"
  | "reservedName"
  | "valueCharacters"
  | "valueTooLarge"
  | "limit"
  | "conflict"
  | "saved";

const DRAFTS: Record<
  Exclude<EditorState, "saved">,
  {
    readonly name: string;
    readonly value: string;
    readonly grant?: string;
    readonly nameError?: string;
    readonly valueError?: string;
    readonly formError?: string;
  }
> = {
  new: { name: "API_BASE_URL", value: "https://api.example.com/v2" },
  edit: {
    name: "LOG_LEVEL",
    value: "info",
    grant: "허락: 모든 에이전트 · 마지막 수정 2026. 10. 18.",
  },
  nameFormat: {
    name: "api-base-url",
    value: "https://api.example.com/v2",
    nameError: "영문 대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있습니다.",
  },
  reservedName: {
    name: "AP_SESSION_ID",
    value: "session-01",
    nameError: "AP_SESSION_ID은 플랫폼이 쓰는 이름이라 등록할 수 없습니다.",
  },
  valueCharacters: {
    name: "LOG_LEVEL",
    value: "\u001b[1minfo",
    valueError: "값에 쓸 수 없는 문자가 있습니다.",
  },
  valueTooLarge: {
    name: "LOG_LEVEL",
    value: "x".repeat(49 * 1024 + 1),
    valueError: "값은 48 KB까지입니다.",
  },
  limit: {
    name: "LOG_LEVEL",
    value: "info",
    formError:
      "변수는 워크스페이스에 100개, 에이전트에 50개까지 등록할 수 있습니다.",
  },
  conflict: {
    name: "LOG_LEVEL",
    value: "debug",
    formError:
      "다른 사람이 먼저 바꿨습니다. 새 값을 확인한 뒤 다시 저장하세요.",
  },
};

function VariableEditorDialogScreen({
  state,
}: {
  readonly state: EditorState;
}) {
  if (state === "saved") {
    return (
      <div className="story-stack">
        {API_CHANGE}
        <Card data-tone="info" role="status">
          <CardHeader>
            <CardDescription className="flex items-start gap-2">
              <Badge variant="blue">안내</Badge>
              <span>저장했습니다. 다음 세션부터 반영됩니다.</span>
            </CardDescription>
            <CardAction>
              <Badge variant="amber" data-part-request="Alert">
                부품 요청 중: Alert
              </Badge>
            </CardAction>
          </CardHeader>
        </Card>
      </div>
    );
  }
  const draft = DRAFTS[state];
  return (
    // Keyed so a changed story arg drops what the viewer typed.
    <ConfirmDialog
      key={state}
      open={true}
      onOpenChange={() => {}}
      onConfirm={() => {}}
      title={state === "new" ? "변수 추가" : "변수 수정"}
      consequence="변수 값은 이 값을 받는 에이전트의 세션 안 도구가 읽을 수 있습니다. 비밀번호나 토큰은 넣지 마세요."
      confirmLabel="저장"
    >
      <FieldGroup>
        {API_CHANGE}
        <Field>
          <FieldLabel>이름</FieldLabel>
          <Input name="name" defaultValue={draft.name} autoComplete="off" />
          <FieldDescription>영문 대문자·숫자·밑줄, 64자까지</FieldDescription>
          <FieldError>{draft.nameError}</FieldError>
        </Field>
        <Field>
          <FieldLabel>값</FieldLabel>
          <Textarea name="value" defaultValue={draft.value} />
          <FieldError>{draft.valueError}</FieldError>
        </Field>
        {draft.grant ? (
          <p className="text-muted-foreground text-caption">{draft.grant}</p>
        ) : null}
        <FieldError>{draft.formError}</FieldError>
      </FieldGroup>
    </ConfirmDialog>
  );
}

const meta = {
  title: "Screens/Variable editor dialog (v3)",
  component: VariableEditorDialogScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "new" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: [
        "new",
        "edit",
        "nameFormat",
        "reservedName",
        "valueCharacters",
        "valueTooLarge",
        "limit",
        "conflict",
        "saved",
      ],
    },
  },
} satisfies Meta<typeof VariableEditorDialogScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VariableEditorDialog: Story = { name: "New" };
export const VariableEditorDialogEdit: Story = {
  name: "Edit",
  args: { state: "edit" },
};
export const VariableEditorDialogNameFormat: Story = {
  name: "Name format error",
  args: { state: "nameFormat" },
};
export const VariableEditorDialogReservedName: Story = {
  name: "Reserved name",
  args: { state: "reservedName" },
};
export const VariableEditorDialogValueCharacters: Story = {
  name: "Value character error",
  args: { state: "valueCharacters" },
};
export const VariableEditorDialogValueTooLarge: Story = {
  name: "Value too large",
  args: { state: "valueTooLarge" },
};
export const VariableEditorDialogLimit: Story = {
  name: "Count limit",
  args: { state: "limit" },
};
export const VariableEditorDialogConflict: Story = {
  name: "Changed by someone else",
  args: { state: "conflict" },
};
export const VariableEditorDialogSaved: Story = {
  name: "Saved",
  args: { state: "saved" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const VariableEditorDialogConflictMobile: Story = {
  name: "Changed by someone else (390px)",
  args: { state: "conflict" },
  globals: MOBILE,
};

export const VariableEditorDialogConflictMobileDark: Story = {
  name: "Changed by someone else (390px, dark)",
  args: { state: "conflict" },
  globals: { ...MOBILE, theme: "dark" },
};

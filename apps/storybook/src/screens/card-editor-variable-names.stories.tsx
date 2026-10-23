import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Textarea,
} from "@werft-ai/ui";

/*
 * S-E5: the names an agent card declares, one per line, in the card editor.
 * Values never live here.
 */

const API_CHANGE = <Badge variant="red">API 변경 필요</Badge>;

type FieldState =
  | "ready"
  | "empty"
  | "nameFormat"
  | "reservedName"
  | "duplicate";

const DRAFTS: Record<
  FieldState,
  { readonly names: string; readonly error?: string }
> = {
  ready: { names: "API_BASE_URL\nLOG_LEVEL" },
  empty: { names: "" },
  nameFormat: {
    names: "API_BASE_URL\nlog-level",
    error: "영문 대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있습니다.",
  },
  reservedName: {
    names: "API_BASE_URL\nAP_SESSION_ID",
    error: "AP_SESSION_ID은 플랫폼이 쓰는 이름이라 등록할 수 없습니다.",
  },
  duplicate: {
    names: "API_BASE_URL\nLOG_LEVEL\nLOG_LEVEL",
    error: "같은 이름을 두 번 적었습니다.",
  },
};

function CardEditorVariableNamesScreen({
  state,
}: {
  readonly state: FieldState;
}) {
  const draft = DRAFTS[state];
  return (
    // Keyed so a changed story arg drops what the viewer typed.
    <form
      key={state}
      className="max-w-md"
      onSubmit={(event) => event.preventDefault()}
    >
      <FieldGroup>
        {API_CHANGE}
        <Field>
          <FieldLabel>받을 변수 이름</FieldLabel>
          <Textarea
            name="variable-names"
            className="font-mono"
            defaultValue={draft.names}
          />
          <FieldDescription>
            여기 적은 이름만 세션에 들어갑니다. 값은 에이전트 상세나
            워크스페이스 설정에서 넣습니다.
          </FieldDescription>
          <FieldError>{draft.error}</FieldError>
        </Field>
        <Field orientation="horizontal">
          <Button type="submit">저장</Button>
          <FieldDescription>저장하면 새 버전이 생깁니다.</FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}

const meta = {
  title: "Screens/Card editor variable names (v3)",
  component: CardEditorVariableNamesScreen,
  parameters: { layout: "fullscreen" },
  args: { state: "ready" },
  argTypes: {
    state: {
      control: "inline-radio",
      options: ["ready", "empty", "nameFormat", "reservedName", "duplicate"],
    },
  },
} satisfies Meta<typeof CardEditorVariableNamesScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CardEditorVariableNames: Story = { name: "Ready" };
export const CardEditorVariableNamesEmpty: Story = {
  name: "Empty",
  args: { state: "empty" },
};
export const CardEditorVariableNamesNameFormat: Story = {
  name: "Name format error",
  args: { state: "nameFormat" },
};
export const CardEditorVariableNamesReservedName: Story = {
  name: "Reserved name",
  args: { state: "reservedName" },
};
export const CardEditorVariableNamesDuplicate: Story = {
  name: "Duplicate name",
  args: { state: "duplicate" },
};

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

export const CardEditorVariableNamesDuplicateMobile: Story = {
  name: "Duplicate name (390px)",
  args: { state: "duplicate" },
  globals: MOBILE,
};

export const CardEditorVariableNamesDuplicateMobileDark: Story = {
  name: "Duplicate name (390px, dark)",
  args: { state: "duplicate" },
  globals: { ...MOBILE, theme: "dark" },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  Field,
  FieldLabel,
  FormActions,
  Input,
  Text,
} from "@werft-ai/ui";
import { useId } from "react";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    label: "Slack 워크스페이스 ID",
    cancel: "취소",
    save: "저장",
    note: "저장하면 연결을 다시 확인합니다.",
  },
  ja: {
    label: "Slack ワークスペース ID",
    cancel: "キャンセル",
    save: "保存",
    note: "保存すると接続をもう一度確認します。",
  },
  en: {
    label: "Slack workspace ID",
    cancel: "Cancel",
    save: "Save",
    note: "Saving checks the connection again.",
  },
} as const;

type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  return COPY[
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko"
  ];
}

function InlineForm({
  copy,
  note,
}: {
  readonly copy: (typeof COPY)[keyof typeof COPY];
  readonly note?: boolean;
}) {
  const inputId = useId();
  return (
    <form
      className="flex max-w-[560px] flex-col gap-4"
      onSubmit={(event) => event.preventDefault()}
    >
      <Field>
        <FieldLabel htmlFor={inputId}>{copy.label}</FieldLabel>
        <Input id={inputId} defaultValue="T0123ABCD" />
      </Field>
      <FormActions>
        {note ? (
          <Text variant="meta" className="mr-auto">
            {copy.note}
          </Text>
        ) : null}
        <Button type="button" variant="ghost">
          {copy.cancel}
        </Button>
        <Button type="submit">{copy.save}</Button>
      </FormActions>
    </form>
  );
}

const meta = {
  title: "Patterns/FormActions",
  component: FormActions,
  render: (_args, context) => <InlineForm copy={copyFor(context)} />,
} satisfies Meta<typeof FormActions>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Cancel and save at the end of an inline form. */
export const Default: Story = {};

export const Dark: Story = { globals: { theme: "dark" } };

export const English: Story = { globals: { locale: "en" } };

/** A note with `mr-auto` keeps to the start; out of room, the row wraps. */
export const WithNote: Story = {
  render: (_args, context) => <InlineForm copy={copyFor(context)} note />,
};

export const WithNoteMobile: Story = {
  ...WithNote,
  name: "With note (mobile)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

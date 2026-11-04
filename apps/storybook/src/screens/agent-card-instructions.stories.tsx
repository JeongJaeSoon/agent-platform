import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Textarea,
} from "@werft-ai/ui";
import { useId } from "react";

/*
 * The card editor's agent instructions field, as
 * apps/web/src/components/agent-card-form.tsx draws it. The copy is
 * apps/web/src/i18n/agents.ts's agentCard.agentInstructions and
 * agentCard.agentInstructionsHint, picked by the toolbar's locale.
 */

type Locale = "ko" | "en" | "ja";

const COPY: Record<Locale, { readonly label: string; readonly hint: string }> =
  {
    ko: {
      label: "에이전트 지시문",
      hint: "이 에이전트의 세션마다 시스템 프롬프트에 붙는 지시입니다. CLAUDE.md나 AGENTS.md에 쓰던 내용을 여기에 적습니다. 저장하면 새 버전이 되고, 그 버전으로 릴리스해 켠 뒤 시작한 세션부터 쓰입니다.",
    },
    en: {
      label: "Agent instructions",
      hint: "Added to the system prompt of every session of this agent: what you would put in a CLAUDE.md or AGENTS.md. Saving makes a new version; sessions use it once that version is released and turned on, starting with the next new session.",
    },
    ja: {
      label: "エージェント指示文",
      hint: "このエージェントのセッションごとにシステムプロンプトに付く指示です。CLAUDE.md や AGENTS.md に書いていた内容をここに書きます。保存すると新しいバージョンになり、そのバージョンでリリースして有効にした後に始まったセッションから使われます。",
    },
  };

function AgentCardInstructionsScreen({ locale }: { readonly locale: Locale }) {
  const { label, hint } = COPY[locale];
  const id = useId();
  return (
    <form className="max-w-2xl" onSubmit={(event) => event.preventDefault()}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Textarea id={id} rows={10} />
          <FieldDescription>{hint}</FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}

const meta = {
  title: "Screens/Agent card instructions",
  component: AgentCardInstructionsScreen,
  args: { locale: "ko" },
  render: (_args, context) => (
    <AgentCardInstructionsScreen
      locale={(context.globals.locale ?? "ko") as Locale}
    />
  ),
} satisfies Meta<typeof AgentCardInstructionsScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentCardInstructionsEmpty: Story = { name: "Empty field" };

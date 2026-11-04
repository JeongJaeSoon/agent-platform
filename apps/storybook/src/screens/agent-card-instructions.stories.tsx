import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_INSTRUCTIONS_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
import { Field, FieldDescription, FieldLabel, Textarea } from "@werft-ai/ui";
import { useId } from "react";

/*
 * The card editor's agent instructions field, as
 * apps/web/src/components/agent-card-form.tsx draws it. The copy is
 * apps/web/src/i18n/agents.ts's agentCard.agentInstructions and
 * agentCard.agentInstructionsHint, picked by the toolbar's locale.
 */

type Locale = "ko" | "en" | "ja";

// agent-card-form.tsx AGENT_FORM: the classes that size the label and the hint.
const AGENT_FORM =
  "flex w-full flex-col gap-4 rounded-card border bg-card p-4 [&_[data-slot=field-description]]:mt-0! [&_[data-slot=field-description]]:text-caption [&_[data-slot=field-label]]:text-control [&_[data-slot=field][data-orientation=vertical]]:gap-2";

const COPY: Record<Locale, { readonly label: string; readonly hint: string }> =
  {
    ko: {
      label: "에이전트 지시문",
      hint: "이 에이전트의 세션마다 시스템 프롬프트에 붙는 지시입니다. CLAUDE.md나 AGENTS.md에 쓰던 내용을 여기에 적습니다. 저장하면 새 버전이 되고, 그 버전으로 릴리스해 켠 뒤 시작한 세션부터 쓰입니다. 연차나 과장된 수식 없이, 담당 범위를 한 줄로 쓰고 허용할 행동을 구체적인 동사와 이유로 적습니다. 예: 결제 장애 분석을 맡습니다. 로그를 읽고 원인을 요약합니다. 변경은 담당 팀이 검토하므로 코드는 고치지 않습니다.",
    },
    en: {
      label: "Agent instructions",
      hint: "Added to the system prompt of every session of this agent: what you would put in a CLAUDE.md or AGENTS.md. Saving makes a new version; sessions use it once that version is released and turned on, starting with the next new session. Skip years of experience and inflated titles: give the scope in one line, and allowed actions as concrete verbs with a reason. Example: Analyze payment incidents. Read logs and summarize the cause. Do not change code, because the owning team reviews every change.",
    },
    ja: {
      label: "エージェント指示文",
      hint: "このエージェントのセッションごとにシステムプロンプトに付く指示です。CLAUDE.md や AGENTS.md に書いていた内容をここに書きます。保存すると新しいバージョンになり、そのバージョンでリリースして有効にした後に始まったセッションから使われます。経験年数や誇張した修飾は書かず、担当範囲を一行で書き、許可する行動を具体的な動詞と理由で書きます。例: 決済障害の分析を担当します。ログを読んで原因を要約します。変更は担当チームがレビューするので、コードは修正しません。",
    },
  };

function AgentCardInstructionsScreen({ locale }: { readonly locale: Locale }) {
  const { label, hint } = COPY[locale];
  const id = useId();
  return (
    <div className="max-w-2xl">
      <form className={AGENT_FORM} onSubmit={(event) => event.preventDefault()}>
        <Field>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Textarea
            id={id}
            maxLength={AGENT_INSTRUCTIONS_MAX_LENGTH}
            rows={10}
          />
          <FieldDescription>{hint}</FieldDescription>
        </Field>
      </form>
    </div>
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

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "@werft-ai/contracts/agent-card";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Textarea,
} from "@werft-ai/ui";
import { useId } from "react";
import { MOBILE } from "./screen-kit.tsx";

/*
 * The card editor's name and description, as apps/web's
 * routes/agent-detail/card-editor.tsx draws them. The copy is
 * apps/web/src/i18n/agents.ts's agent.card.identity, agent.card.identityHint,
 * agents.name and agents.description, picked by the toolbar's locale.
 */

type Locale = "ko" | "en" | "ja";

// agent-card-form.tsx AGENT_FORM: the classes that size the label and the hint.
const AGENT_FORM =
  "flex w-full flex-col gap-4 rounded-card border bg-card p-4 [&_[data-slot=field-description]]:mt-0! [&_[data-slot=field-description]]:text-caption [&_[data-slot=field-label]]:text-control [&_[data-slot=field][data-orientation=vertical]]:gap-2";

const COPY: Record<
  Locale,
  {
    readonly legend: string;
    readonly hint: string;
    readonly name: string;
    readonly description: string;
  }
> = {
  ko: {
    legend: "이름과 설명",
    hint: "사람이 보는 값입니다. 새 버전이나 릴리스 없이 바로 바뀌고, 에이전트의 동작에는 영향이 없습니다.",
    name: "이름",
    description: "설명",
  },
  en: {
    legend: "Name and description",
    hint: "For people to read. They change at once, with no new version or release, and do not affect how the agent behaves.",
    name: "Name",
    description: "Description",
  },
  ja: {
    legend: "名前と説明",
    hint: "人が見るための値です。新しいバージョンやリリースなしですぐに変わり、エージェントの動作には影響しません。",
    name: "名前",
    description: "説明",
  },
};

function AgentCardIdentityScreen({ locale }: { readonly locale: Locale }) {
  const { legend, hint, name, description } = COPY[locale];
  const nameId = useId();
  const descriptionId = useId();
  return (
    <div className="max-w-2xl">
      <form className={AGENT_FORM} onSubmit={(event) => event.preventDefault()}>
        <FieldSet className="gap-4">
          <FieldLegend>{legend}</FieldLegend>
          <FieldDescription>{hint}</FieldDescription>
          <Field>
            <FieldLabel htmlFor={nameId}>{name}</FieldLabel>
            <Input
              id={nameId}
              required={true}
              maxLength={120}
              defaultValue="결제 담당"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={descriptionId}>{description}</FieldLabel>
            <Textarea
              id={descriptionId}
              maxLength={AGENT_DESCRIPTION_MAX_LENGTH}
              rows={3}
              defaultValue="결제 문의 담당"
            />
          </Field>
        </FieldSet>
      </form>
    </div>
  );
}

const meta = {
  title: "Screens/Agent card identity",
  component: AgentCardIdentityScreen,
  args: { locale: "ko" },
  render: (_args, context) => (
    <AgentCardIdentityScreen
      locale={(context.globals.locale ?? "ko") as Locale}
    />
  ),
} satisfies Meta<typeof AgentCardIdentityScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AgentCardIdentity: Story = { name: "Name and description" };
export const AgentCardIdentityMobile: Story = {
  name: "Name and description (390px)",
  globals: MOBILE,
};
export const AgentCardIdentityMobileDark: Story = {
  name: "Name and description (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};
export const AgentCardIdentityEnglishMobile: Story = {
  name: "Name and description (English, 390px)",
  globals: { ...MOBILE, locale: "en" },
};
export const AgentCardIdentityJapaneseMobile: Story = {
  name: "Name and description (Japanese, 390px)",
  globals: { ...MOBILE, locale: "ja" },
};

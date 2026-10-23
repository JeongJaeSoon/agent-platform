import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, PageHeader } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY = {
  ko: {
    title: "세션",
    description: "에이전트가 맡은 일과 진행 상황을 봅니다.",
    action: "새로 만들기",
  },
  ja: {
    title: "セッション",
    description: "エージェントに任せた作業と進み具合を確認します。",
    action: "新規作成",
  },
  en: {
    title: "Sessions",
    description: "See what your agents are working on and how far they got.",
    action: "New",
  },
} as const;

type Locale = keyof typeof COPY;
type Globals = { readonly globals: { readonly locale?: string } };

function copyFor({ globals }: Globals) {
  const locale: Locale =
    globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";
  return COPY[locale];
}

const meta = {
  title: "Patterns/PageHeader",
  component: PageHeader,
  args: { title: COPY.ko.title },
  render: (args, context) => {
    const copy = copyFor(context);
    return (
      <PageHeader
        {...args}
        title={copy.title}
        description={copy.description}
        actions={<Button type="button">{copy.action}</Button>}
      />
    );
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Follows the toolbar's Language; the stories below pin each one. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const Japanese: Story = { globals: { locale: "ja" } };

export const JapaneseDark: Story = {
  name: "Japanese (dark)",
  globals: { locale: "ja", theme: "dark" },
};

export const English: Story = { globals: { locale: "en" } };

export const EnglishDark: Story = {
  name: "English (dark)",
  globals: { locale: "en", theme: "dark" },
};

export const TitleOnly: Story = {
  render: (args, context) => (
    <PageHeader {...args} title={copyFor(context).title} />
  ),
};

export const Mobile: Story = {
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

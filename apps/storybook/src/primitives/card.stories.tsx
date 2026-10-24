import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
} from "@werft-ai/ui";

const meta = {
  title: "Primitives/Card",
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card>
      <CardHeader>
        <CardTitle>결제 담당</CardTitle>
        <CardDescription>
          청구서 문의에 답하고 환불을 접수합니다.
        </CardDescription>
        <CardAction>
          <Badge variant="gray">초안</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {/* An unbreakable identifier: the case that overflows a narrow card. */}
        <p className="break-all font-mono text-sm">{`agt_${"0".repeat(60)}`}</p>
      </CardContent>
      <CardFooter className="gap-2">
        <Button type="button">이어서 설정</Button>
        <Button type="button" variant="ghost">
          나중에
        </Button>
      </CardFooter>
    </Card>
  ),
};

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  ...Default,
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

// The kit has no messages of its own; these stand in for apps/web's.
const FORM_COPY = {
  ko: {
    title: "감사 기록 보관 기간",
    description: "허용·거부 결정을 며칠 동안 보관할지 정합니다.",
    label: "보관 일수",
    foot: "바꾼 값은 다음 정리부터 적용됩니다.",
    save: "저장",
  },
  ja: {
    title: "監査記録の保存期間",
    description: "許可・拒否の判断を何日間保存するかを決めます。",
    label: "保存日数",
    foot: "変更した値は次回の整理から適用されます。",
    save: "保存",
  },
  en: {
    title: "Audit retention",
    description: "How many days allowed and refused decisions are kept.",
    label: "Days kept",
    foot: "A new value applies from the next cleanup.",
    save: "Save",
  },
} as const;

/**
 * A settings card (mockup v4 `.card.flush` + `.form-foot`): the body pads
 * itself and the sunken strip runs edge to edge.
 */
export const FlushForm: Story = {
  render: (_args, { globals }) => {
    const locale: string = globals.locale;
    const copy = FORM_COPY[locale === "ja" || locale === "en" ? locale : "ko"];
    return (
      <Card flush className="max-w-[var(--ap-w-narrow)]">
        <CardContent className="flex flex-col gap-3 py-4">
          <CardTitle role="heading" aria-level={2}>
            {copy.title}
          </CardTitle>
          <CardDescription className="text-description">
            {copy.description}
          </CardDescription>
          <Input
            aria-label={copy.label}
            className="max-w-50"
            type="number"
            defaultValue={90}
          />
        </CardContent>
        <CardFooter variant="form">
          <span className="text-caption text-subtle-foreground">
            {copy.foot}
          </span>
          <Button type="button" size="sm">
            {copy.save}
          </Button>
        </CardFooter>
      </Card>
    );
  },
};

export const FlushFormDark: Story = {
  ...FlushForm,
  name: "Flush form (dark)",
  globals: { theme: "dark" },
};

export const FlushFormMobile: Story = {
  ...FlushForm,
  name: "Flush form (390px)",
  globals: {
    locale: "ja",
    viewport: { value: "mobile390", isRotated: false },
  },
};

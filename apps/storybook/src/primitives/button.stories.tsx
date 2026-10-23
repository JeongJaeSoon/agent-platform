import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@werft-ai/ui";
import { Copy, Pause } from "lucide-react";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: { type: "button", children: "기본" },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "outline",
        "secondary",
        "ghost",
        "destructive",
        "danger",
        "link",
      ],
    },
    size: {
      control: "select",
      options: ["default", "sm", "icon", "icon-sm"],
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

// The toolbar's Language picks the label, so each catalog's width shows.
const LABEL: Record<string, string> = { ko: "저장", ja: "保存", en: "Save" };

export const Default: Story = {
  render: (args, { globals }) => (
    <Button {...args}>{LABEL[globals.locale] ?? LABEL.ko}</Button>
  ),
};

export const Disabled: Story = { ...Default, args: { disabled: true } };

export const Variants: Story = {
  render: () => (
    <div className="story-row">
      <Button type="button">기본</Button>
      <Button type="button" variant="outline">
        테두리
      </Button>
      <Button type="button" variant="secondary">
        보조
      </Button>
      <Button type="button" variant="ghost">
        조용히
      </Button>
      <Button type="button" variant="destructive">
        삭제
      </Button>
      <Button type="button" variant="danger">
        세션 종료
      </Button>
      <Button type="button" variant="link">
        링크
      </Button>
      <Button type="button" size="sm">
        작게
      </Button>
      <Button type="button" disabled={true}>
        잠김
      </Button>
      <Button asChild={true} variant="outline">
        <a href="/agents">링크를 버튼처럼</a>
      </Button>
    </div>
  ),
};

export const VariantsDark: Story = {
  ...Variants,
  name: "Variants (dark)",
  globals: { theme: "dark" },
};

/** Square icon buttons: 32px `icon` and 28px `icon-sm`, such as copy an ID. */
export const IconSizes: Story = {
  render: () => (
    <div className="story-row">
      <Button type="button" variant="outline" size="icon" aria-label="일시정지">
        <Pause strokeWidth={1.5} aria-hidden="true" />
      </Button>
      <Button type="button" variant="outline" size="icon-sm" aria-label="복사">
        <Copy strokeWidth={1.5} aria-hidden="true" />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="복사">
        <Copy strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  ),
};

/** Outlined `danger` beside the filled `destructive`, enabled and disabled. */
export const Danger: Story = {
  render: () => (
    <div className="story-row">
      <Button type="button" variant="danger">
        세션 종료
      </Button>
      <Button type="button" variant="danger" disabled={true}>
        세션 종료
      </Button>
      <Button type="button" variant="destructive">
        삭제
      </Button>
      <Button type="button" variant="destructive" disabled={true}>
        삭제
      </Button>
    </div>
  ),
};

export const DisabledVariants: Story = {
  name: "Disabled variants",
  render: () => (
    <div className="story-row">
      <Button type="button" disabled={true}>
        기본
      </Button>
      <Button type="button" variant="outline" disabled={true}>
        테두리
      </Button>
      <Button type="button" variant="ghost" disabled={true}>
        조용히
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={true}
        aria-label="복사"
      >
        <Copy strokeWidth={1.5} aria-hidden="true" />
      </Button>
    </div>
  ),
};

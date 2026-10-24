import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, DisabledReason } from "@werft-ai/ui";

// The kit has no messages of its own; these stand in for apps/web's.
const COPY: Record<string, { disable: string; reason: string }> = {
  ko: { disable: "비활성화", reason: "자기 자신은 비활성화할 수 없습니다." },
  ja: { disable: "無効化", reason: "自分自身は無効化できません。" },
  en: { disable: "Disable", reason: "You cannot disable yourself." },
};

const meta = {
  title: "Patterns/DisabledReason",
  component: DisabledReason,
  // Each render supplies the control and its reason.
  args: { reason: "", label: "", children: <span /> },
  // A table's actions column: the withheld button keeps the enabled ones'
  // right edge and width. Hover or Tab to it for the reason.
  render: (_, { globals }) => {
    const copy = COPY[globals.locale] ?? COPY.ko;
    return (
      <div className="flex flex-col items-end gap-2 pt-16">
        <Button type="button" variant="outline" size="sm">
          {copy?.disable}
        </Button>
        <DisabledReason reason={copy?.reason} label={copy?.disable ?? ""}>
          <Button type="button" variant="outline" size="sm" disabled={true}>
            {copy?.disable}
          </Button>
        </DisabledReason>
        <Button type="button" variant="outline" size="sm">
          {copy?.disable}
        </Button>
      </div>
    );
  },
} satisfies Meta<typeof DisabledReason>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Focused from the start so the a11y run and a screenshot see the note.
export const Open: Story = {
  play: async ({ canvasElement }) => {
    canvasElement
      .querySelector<HTMLElement>("[data-slot=disabled-reason]")
      ?.focus();
  },
};

export const Dark: Story = {
  ...Open,
  globals: { theme: "dark" },
};

export const Mobile390: Story = {
  ...Open,
  name: "Open (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

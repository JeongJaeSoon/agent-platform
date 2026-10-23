import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@werft-ai/ui";
import { Pause, Square } from "lucide-react";

const LABEL: Record<string, { pause: string; stop: string; note: string }> = {
  ko: {
    pause: "일시정지",
    stop: "종료",
    note: "실행을 잠시 멈춥니다. 다시 시작하면 이어서 진행합니다.",
  },
  ja: {
    pause: "一時停止",
    stop: "終了",
    note: "実行を一時停止します。再開すると続きから進みます。",
  },
  en: {
    pause: "Pause",
    stop: "Stop",
    note: "Pauses the run. Resuming picks up where it left off.",
  },
};

const meta = {
  title: "Primitives/Tooltip",
  component: Tooltip,
  // Each render supplies the trigger and note.
  args: { children: null },
  // Hover, Tab or press the button to open it.
  render: (args, { globals }) => {
    const label = LABEL[globals.locale] ?? LABEL.ko;
    return (
      <div className="story-row">
        <Tooltip {...args}>
          <TooltipTrigger asChild={true}>
            <Button type="button" variant="outline">
              {label?.pause}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label?.note}</TooltipContent>
        </Tooltip>
      </div>
    );
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// Open from the start so the a11y run and a screenshot see the note.
export const Open: Story = { args: { open: true } };

export const LongText: Story = {
  args: { open: true },
  render: (args) => (
    <div className="story-row">
      <Tooltip {...args}>
        <TooltipTrigger asChild={true}>
          <Button type="button" variant="outline">
            자세히
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          이 에이전트는 워크스페이스 관리자만 비활성화할 수 있습니다. 관리자에게
          요청하거나, 설정에서 권한을 확인하세요. 긴 글은 상자 폭 안에서 줄을
          바꿉니다.
        </TooltipContent>
      </Tooltip>
    </div>
  ),
};

// Square icon buttons name themselves with aria-label; the note adds why.
export const IconButtons: Story = {
  args: { open: true },
  render: (args, { globals }) => {
    const label = LABEL[globals.locale] ?? LABEL.ko;
    return (
      <div className="story-row">
        <Tooltip {...args}>
          <TooltipTrigger asChild={true}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={label?.pause}
            >
              <Pause aria-hidden="true" size={16} strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label?.pause}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild={true}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={label?.stop}
            >
              <Square aria-hidden="true" size={16} strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label?.stop}</TooltipContent>
        </Tooltip>
      </div>
    );
  },
};

export const Dark: Story = {
  ...Open,
  globals: { theme: "dark" },
};

export const IconButtonsDark: Story = {
  ...IconButtons,
  name: "Icon buttons (dark)",
  globals: { theme: "dark" },
};

export const Mobile390: Story = {
  ...LongText,
  name: "Long text (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

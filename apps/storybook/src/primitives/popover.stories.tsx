import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@werft-ai/ui";
import { Info } from "lucide-react";

const meta = {
  title: "Primitives/Popover",
  component: Popover,
  // Open from the start so the a11y run and a screenshot see the note.
  args: { defaultOpen: true },
  render: (args) => (
    <div className="story-row">
      <Button type="button" variant="outline" size="sm" disabled={true}>
        비활성화
      </Button>
      <Popover {...args}>
        <PopoverTrigger asChild={true}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="비활성화할 수 없는 이유"
          >
            <Info aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        {/* Focus moves into the note, so it carries the button's name. */}
        <PopoverContent aria-label="비활성화할 수 없는 이유">
          자기 자신은 비활성화할 수 없습니다.
        </PopoverContent>
      </Popover>
    </div>
  ),
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
  globals: { theme: "dark" },
};

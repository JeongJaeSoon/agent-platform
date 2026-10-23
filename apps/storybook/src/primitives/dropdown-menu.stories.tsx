import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@werft-ai/ui";
import { Bot, ChevronDown, List, Users, UsersRound } from "lucide-react";

const meta = {
  title: "Primitives/DropdownMenu",
  component: DropdownMenu,
  // Open from the start so the a11y run and a screenshot see the items.
  args: { defaultOpen: true, modal: false },
  render: (args) => (
    <DropdownMenu {...args}>
      <DropdownMenuTrigger asChild={true}>
        <Button type="button" variant="outline" size="sm">
          새로 만들기
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem>
          <Bot aria-hidden="true" />새 에이전트
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Users aria-hidden="true" />
          구성원 초대
        </DropdownMenuItem>
        <DropdownMenuItem>
          <UsersRound aria-hidden="true" />팀 만들기
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Focusable but inert, so a screen reader reaches the reason. */}
        <DropdownMenuItem
          aria-disabled="true"
          onSelect={(event) => event.preventDefault()}
        >
          <List aria-hidden="true" />
          <span className="flex flex-col">
            새 세션
            <span className="text-caption">
              웹에서는 아직 시작할 수 없습니다
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
} satisfies Meta<typeof DropdownMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Dark: Story = {
  globals: { theme: "dark" },
};

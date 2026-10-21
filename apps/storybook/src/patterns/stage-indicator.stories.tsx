import { presentTurnEvent } from "@agent-platform/contracts";
import { StageIndicator } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { formatMessage } from "./session-fixtures.ts";

const meta = {
  title: "Patterns/Session/StageIndicator",
  component: StageIndicator,
  args: {
    presentation: presentTurnEvent({
      event: "tool_use",
      data: {
        message: {
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "Bash",
              input: { description: "Run the tests" },
            },
          ],
        },
      },
    }),
    formatMessage,
    emptyLabel: "No activity yet",
    busy: true,
  },
} satisfies Meta<typeof StageIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { presentation: null, busy: false } };

export const Loading: Story = {
  args: {
    presentation: presentTurnEvent({
      event: "status",
      data: { phase: "queued" },
    }),
  },
};

export const Failed: Story = {
  args: {
    presentation: presentTurnEvent({
      event: "error",
      data: { message: "The engine stopped before the turn finished." },
    }),
    busy: false,
  },
};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const FailedDark: Story = {
  ...Failed,
  name: "Failed (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

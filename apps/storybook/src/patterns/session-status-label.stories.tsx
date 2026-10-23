import type { Meta, StoryObj } from "@storybook/react-vite";
import { SESSION_STATUS_VALUES } from "@werft-ai/contracts";
import { SessionStatusLabel } from "@werft-ai/react/components";

import { SESSION_ROW_MESSAGES } from "./session-fixtures.ts";

const meta = {
  title: "Patterns/Session/SessionStatusLabel",
  component: SessionStatusLabel,
  args: { status: "running", label: "Working", axisLabel: "Status" },
} satisfies Meta<typeof SessionStatusLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllStatuses: Story = {
  render: () => (
    <div className="story-row">
      {SESSION_STATUS_VALUES.map((status) => (
        <SessionStatusLabel
          key={status}
          status={status}
          label={SESSION_ROW_MESSAGES.status(status)}
          axisLabel="Status"
        />
      ))}
    </div>
  ),
};

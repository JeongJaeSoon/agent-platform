import { SESSION_STATUS_VALUES } from "@agent-platform/contracts";
import { SessionStatusLabel } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SESSION_ROW_MESSAGES } from "./session-fixtures.ts";

const meta = {
  title: "Patterns/Session/SessionStatusLabel",
  component: SessionStatusLabel,
  args: { status: "running", label: "Working", axisLabel: "Status" },
} satisfies Meta<typeof SessionStatusLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Every session status, so the turn axis's tones are seen side by side. */
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

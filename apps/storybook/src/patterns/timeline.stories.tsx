import { Timeline } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  FAILED_EVENTS,
  formatMessage,
  TIMELINE_MESSAGES,
  TURN_EVENTS,
  timelineEntries,
} from "./session-fixtures.ts";

const meta = {
  title: "Patterns/Session/Timeline",
  component: Timeline,
  args: {
    entries: timelineEntries(TURN_EVENTS),
    formatMessage,
    messages: TIMELINE_MESSAGES,
    locale: "en",
  },
} satisfies Meta<typeof Timeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Thinking ticks fold into one line; SDK bookkeeping stays hidden. */
export const Default: Story = {};

export const WithDebug: Story = { args: { showDebug: true } };

export const Empty: Story = { args: { entries: [] } };

export const Loading: Story = { args: { entries: [], state: "connecting" } };

export const Failed: Story = {
  args: { entries: timelineEntries(FAILED_EVENTS), state: "closed" },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {Object.entries({ Default, Empty, Loading, Failed }).map(
        ([name, story]) => (
          <Timeline key={name} {...args} {...story.args} />
        ),
      )}
    </div>
  ),
};

export const StatesDark: Story = {
  ...States,
  name: "States (dark)",
  globals: { theme: "dark" },
};

export const StatesMobile: Story = {
  ...States,
  name: "States (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

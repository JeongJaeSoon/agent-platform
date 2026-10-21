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

import { SessionRow, Skeleton } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SESSION, SESSION_ROW_MESSAGES } from "./session-fixtures.ts";

const meta = {
  title: "Patterns/Session/SessionRow",
  component: SessionRow,
  args: {
    session: SESSION,
    href: `/sessions/${SESSION.id}`,
    messages: SESSION_ROW_MESSAGES,
    locale: "en",
  },
} satisfies Meta<typeof SessionRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Just created: no runtime from the catalog and no event so far. */
export const Empty: Story = {
  args: {
    session: {
      ...SESSION,
      status: "queued",
      runtime: null,
      current_turn_id: null,
      queued_turn_count: 0,
      last_event_at: null,
    },
  },
};

/** What a list shows in a row's place while it loads. */
export const Loading: Story = {
  render: () => (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <Skeleton width="30%" label="Loading session" />
      <Skeleton width="70%" />
    </div>
  ),
};

export const Failed: Story = {
  args: {
    session: {
      ...SESSION,
      status: "failed",
      admission_state: "recovery_required",
      queued_turn_count: 0,
    },
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

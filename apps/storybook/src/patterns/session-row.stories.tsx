import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionRow, SessionTable } from "@werft-ai/react/components";
import { Skeleton } from "@werft-ai/ui";

import { SESSION, SESSION_ROW_MESSAGES } from "./session-fixtures.ts";

const TABLE_MESSAGES = {
  id: "Session ID",
  status: SESSION_ROW_MESSAGES.statusAxis,
  admission: SESSION_ROW_MESSAGES.admissionAxis,
  runtime: SESSION_ROW_MESSAGES.runtime,
  lastEvent: SESSION_ROW_MESSAGES.lastEvent,
  created: SESSION_ROW_MESSAGES.created,
};

const meta = {
  title: "Patterns/Session/SessionRow",
  globals: { locale: "en" },
  component: SessionRow,
  render: (args) => (
    <SessionTable label="Sessions" messages={TABLE_MESSAGES}>
      <SessionRow {...args} />
    </SessionTable>
  ),
  args: {
    session: SESSION,
    renderLink: (link) => <a href={`/sessions/${SESSION.id}`} {...link} />,
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
function LoadingRow() {
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <Skeleton width="30%" label="Loading session" />
      <Skeleton width="70%" />
    </div>
  );
}

export const Loading: Story = { render: () => <LoadingRow /> };

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

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      <SessionTable label="Sessions" messages={TABLE_MESSAGES}>
        <SessionRow {...args} />
        <SessionRow {...args} {...Empty.args} />
        <SessionRow {...args} {...Failed.args} />
      </SessionTable>
      <LoadingRow />
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

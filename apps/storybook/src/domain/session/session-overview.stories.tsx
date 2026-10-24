import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  SessionOverviewRow,
  SessionOverviewTable,
} from "@werft-ai/react/components";

import { SESSION } from "./session-fixtures.ts";

const HEAD = {
  session: "Session",
  status: "Status",
  model: "Model",
  agent: "Agent · Model",
  repository: "Repository",
  startedBy: "Started by",
  recent: "Recent",
};

/** v4 `.t-sess-home`: the same table without the started-by column. */
const HOME_HEAD = {
  session: "Session",
  status: "Status",
  model: "Model",
  agent: "Agent · Model",
  repository: "Repository",
  recent: "Recent",
};

const MESSAGES = {
  status: (status: string) =>
    ({
      queued: "Queued",
      running: "Working",
      needs_input: "Waiting for an answer",
      idle: "Idle",
      failed: "Failed",
      stopped: "Stopped",
    })[status] ?? status,
  statusAxis: "Status",
  noRepository: "No repository",
  unknown: "—",
  recent: "Recent",
  open: (name: string) => `Open session: ${name}`,
};

const AGENT = {
  id: "0192f0c4-7d3a-7b4e-9f00-0000000000a1",
  name: "Release helper",
  release_version_no: 3,
};
const STARTER = {
  user_id: "0192f0c4-7d3a-7b4e-9f00-0000000000b1",
  display_name: "Alex Rivera",
};

const meta = {
  title: "Domain/Session/SessionOverviewRow",
  globals: { locale: "en" },
  component: SessionOverviewRow,
  render: (args) => (
    <SessionOverviewTable label="Sessions" messages={HEAD}>
      <SessionOverviewRow {...args} />
    </SessionOverviewTable>
  ),
  args: {
    session: {
      ...SESSION,
      title: "Write hello.txt and commit",
      agent: AGENT,
      created_by: STARTER,
    },
    renderLink: (link) => <a href={`/sessions/${SESSION.id}`} {...link} />,
    messages: MESSAGES,
    locale: "en",
  },
} satisfies Meta<typeof SessionOverviewRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * Created before titles existed: the id's head, no repository, and neither
 * an agent nor a recorded starter.
 */
export const Untitled: Story = {
  args: {
    session: { ...SESSION, title: null, repository_id: null, repository: null },
  },
};

/** The home page's five columns, for a table that names no starter. */
export const HomeColumns: Story = {
  render: (args) => (
    <SessionOverviewTable label="Recent sessions" messages={HOME_HEAD}>
      <SessionOverviewRow {...args} />
    </SessionOverviewTable>
  ),
};

/** The wait comes from the oldest pending request's created_at. */
export const Waiting: Story = {
  args: {
    session: { ...SESSION, title: "Tidy the README", status: "needs_input" },
    statusDetail: "12 min",
  },
};

/** Every status, so dark and 390px cover the dot and the turning ring. */
export const States: Story = {
  render: (args) => (
    <SessionOverviewTable label="Sessions" messages={HEAD}>
      {(
        [
          "needs_input",
          "running",
          "idle",
          "stopped",
          "failed",
          "queued",
        ] as const
      ).map((status, index) => (
        <SessionOverviewRow
          {...args}
          key={status}
          session={{
            ...SESSION,
            id: `${SESSION.id.slice(0, -1)}${index}`,
            title: `Session ${index + 1}`,
            status,
          }}
        />
      ))}
    </SessionOverviewTable>
  ),
};

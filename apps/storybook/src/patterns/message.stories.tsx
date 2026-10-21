import { Message, Skeleton } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

const meta = {
  title: "Patterns/Session/Message",
  globals: { locale: "en" },
  component: Message,
  args: {
    from: "assistant",
    author: "Agent",
    text: "All 12 tests pass. I also fixed the flaky timeout in api.test.ts.",
    occurredAt: "2026-10-21T01:00:40.000Z",
    locale: "en",
  },
} satisfies Meta<typeof Message>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sent: Story = {
  args: {
    from: "user",
    author: "You",
    text: "Run the tests and fix what fails.",
    receipt: { status: "succeeded", label: "Delivered" },
  },
};

/** An empty body draws nothing, so no empty bubble reaches the screen. */
export const Empty: Story = { args: { text: "" } };

/** Accepted is not delivered: the turn has not picked it up yet. */
export const Loading: Story = {
  args: {
    ...Sent.args,
    receipt: { status: "accepted", label: "Accepted" },
  },
};

export const Failed: Story = {
  args: {
    ...Sent.args,
    receipt: { status: "failed", label: "Not sent" },
    error: "The session is paused.",
  },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      <Message {...args} />
      <Message {...args} {...Sent.args} />
      <Message {...args} {...Loading.args} />
      <Message {...args} {...Failed.args} />
      <Skeleton width="60%" label="Loading messages" />
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

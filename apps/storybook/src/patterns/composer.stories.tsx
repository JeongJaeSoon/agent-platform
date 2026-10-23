import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "@werft-ai/react/components";

const meta = {
  title: "Patterns/Session/Composer",
  globals: { locale: "en" },
  component: Composer,
  args: {
    messages: {
      label: "Message",
      send: "Send",
      hint: "Ctrl+Enter sends.",
      queued: "Sent after this turn",
    },
    placeholder: "Ask the agent",
    onSend: () => new Promise((resolve) => setTimeout(resolve, 400)),
    queued: [{ id: "q1", text: "Then open a pull request." }],
  },
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A message typed while a turn runs waits in the list above. */
export const Default: Story = {};

export const Empty: Story = { args: { queued: [] } };

export const Loading: Story = { args: { pending: true } };

export const Failed: Story = {
  args: {
    queued: [],
    error: "The message was not sent. Try again.",
  },
};

export const Disabled: Story = {
  args: {
    queued: [],
    disabled: true,
    disabledReason: "The session has ended.",
  },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {Object.entries({ Default, Empty, Loading, Failed, Disabled }).map(
        ([name, story]) => (
          <Composer key={name} {...args} {...story.args} />
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

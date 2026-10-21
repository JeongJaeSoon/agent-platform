import { ApprovalCard, type PermissionRequest } from "@agent-platform/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";

// A fixed clock, as in the other stories.
const NOW = Date.parse("2026-10-21T01:00:00.000Z");

const REQUEST: PermissionRequest = {
  request_id: "req_01",
  turn_id: "1",
  attempt_id: "att_01",
  kind: "permission",
  tool: "Bash",
  input: {
    command: "echo alpha > hello.txt",
    description: "write hello.txt",
  },
  created_at: "2026-10-21T00:59:00.000Z",
  expires_at: "2026-10-21T01:10:00.000Z",
};

const meta = {
  title: "Patterns/Session/ApprovalCard",
  component: ApprovalCard,
  args: {
    request: REQUEST,
    messages: {
      title: (tool: string) => `${tool} wants to run`,
      input: "Show input",
      expires: (at: string) => `Answer by ${at}`,
      expired: "This request expired.",
      allow: "Allow",
      deny: "Deny",
      denyReason: "Why deny?",
      denySubmit: "Deny",
      cancel: "Cancel",
    },
    onAllow: () => {},
    onDeny: () => {},
    now: NOW,
    locale: "en",
  },
} satisfies Meta<typeof ApprovalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Nothing to answer once it expired. */
export const Empty: Story = {
  args: { now: Date.parse(REQUEST.expires_at) },
};

/** The answer is on its way. */
export const Loading: Story = { args: { pending: true } };

export const Failed: Story = {
  args: { error: "The answer was refused: the request already expired." },
};

/** Every state above in one column, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-3">
      {Object.entries({ Default, Empty, Loading, Failed }).map(
        ([name, story]) => (
          <ApprovalCard key={name} {...args} {...story.args} />
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

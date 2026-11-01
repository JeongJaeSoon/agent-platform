import type { Meta, StoryObj } from "@storybook/react-vite";
import { sessionsEn, sessionsJa, sessionsKo } from "@werft-ai/react";
import {
  ApprovalRow,
  type ApprovalRowMessages,
  type PermissionRequest,
} from "@werft-ai/react/components";

// A fixed clock, as in the other stories.
const NOW = Date.parse("2026-10-21T01:00:00.000Z");
const SESSION_SHORT = "0192f0c4";

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

// The blocks' own wording, so each language story reads as the console does.
function messagesFrom(
  catalog: Record<keyof typeof sessionsKo, string>,
): ApprovalRowMessages {
  const fill = (key: keyof typeof sessionsKo, vars: Record<string, string>) =>
    catalog[key].replace(
      /\{(\w+)\}/g,
      (whole, name: string) => vars[name] ?? whole,
    );
  return {
    title: (tool) => fill("session.pending.permission", { tool }),
    input: catalog["session.answer.input"],
    expires: (at) => fill("session.pending.expires", { at }),
    expired: catalog["session.pending.expired"],
    allow: catalog["session.answer.allow"],
    deny: catalog["session.answer.deny"],
    allowName: (tool) =>
      fill("session.answer.allowFor", { tool, session: SESSION_SHORT }),
    denyName: (tool) =>
      fill("session.answer.denyFor", { tool, session: SESSION_SHORT }),
    denyReason: catalog["session.answer.denyReason"],
    denySubmit: catalog["session.answer.denySubmit"],
    cancel: catalog["session.answer.cancel"],
  };
}

const subject = (
  <a href="#session" className="font-mono text-link underline">
    <code>{SESSION_SHORT}…</code>
  </a>
);

const meta = {
  title: "Domain/Session/ApprovalRow",
  globals: { locale: "en" },
  component: ApprovalRow,
  args: {
    request: REQUEST,
    messages: messagesFrom(sessionsEn),
    onAllow: () => {},
    onDeny: () => {},
    now: NOW,
    locale: "en",
    subject,
  },
} satisfies Meta<typeof ApprovalRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The answer is on its way. */
export const Pending: Story = { args: { pending: true } };

/** The reader may not answer; the block says why above the list. */
export const Disabled: Story = { args: { disabled: true } };

/** Nothing to answer once it expired. */
export const Expired: Story = {
  args: { now: Date.parse(REQUEST.expires_at) },
};

export const Failed: Story = {
  name: "Error",
  args: {
    error: "This request was already answered, expired, or closed.",
  },
};

/** The denial form opens below the line, in place of the buttons. */
export const Denying: Story = {
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /^Deny:/ }));
  },
};

/** A long MCP tool name wraps inside the line; the buttons keep their end. */
export const LongToolName: Story = {
  args: {
    request: {
      ...REQUEST,
      tool: "mcp__remote-github-enterprise__create_pull_request_review_comment",
    },
  },
};

export const Korean: Story = {
  name: "Default (한국어)",
  globals: { locale: "ko" },
  args: { messages: messagesFrom(sessionsKo), locale: "ko" },
};

export const Japanese: Story = {
  name: "Default (日本語)",
  globals: { locale: "ja" },
  args: { messages: messagesFrom(sessionsJa), locale: "ja" },
};

/** Every state above in one list, so dark and 390px cover them all. */
export const States: Story = {
  render: (args) => (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {Object.entries({
        Default,
        Pending,
        Disabled,
        Expired,
        Failed,
        LongToolName,
      }).map(([name, story]) => (
        <li key={name}>
          <ApprovalRow {...args} {...story.args} />
        </li>
      ))}
    </ul>
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

export const DenyingMobile: Story = {
  ...Denying,
  name: "Denying (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

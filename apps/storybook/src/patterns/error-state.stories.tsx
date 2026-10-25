import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorState } from "@werft-ai/ui";
import { fn } from "storybook/test";

const meta = {
  title: "Patterns/ErrorState",
  component: ErrorState,
  args: {
    guidance: "보관된 세션입니다 — 새 세션으로 이어가세요.",
    message: "session is closed",
    code: "SESSION_CLOSED",
  },
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** With a retry and an evidence link. */
export const Default: Story = {
  args: {
    retry: fn(),
    evidenceLink: { href: "/sessions/01J8Z5/journal" },
  },
};

/** Without guidance the message is the only line under the title. */
export const MessageOnly: Story = {
  args: { guidance: undefined, code: undefined, retry: fn() },
};

export const DefaultDark: Story = {
  ...Default,
  name: "Default (dark)",
  globals: { theme: "dark" },
};

export const DefaultMobile: Story = {
  ...Default,
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

/** Console v4 L516: title, one line, the request id, a retry. */
export const CodeAndRetry: Story = {
  args: {
    title: "홈을 불러오지 못했습니다",
    guidance: "잠시 뒤 다시 시도하세요.",
    message: undefined,
    code: "req_01JBA7T2K9QX4M",
    retry: fn(),
  },
};

/** In a card, where the console shows it. */
export const InCard: Story = {
  ...CodeAndRetry,
  decorators: [
    (Story) => (
      <div className="rounded-card border bg-card">
        <Story />
      </div>
    ),
  ],
};

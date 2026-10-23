import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorState } from "@werft-ai/ui";
import { fn } from "storybook/test";

const meta = {
  title: "States/ErrorState",
  component: ErrorState,
  args: {
    guidance: "보관된 세션입니다 — 새 세션으로 이어가세요.",
    message: "session is closed",
    code: "SESSION_CLOSED",
  },
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithRetryAndEvidence: Story = {
  args: {
    retry: fn(),
    evidenceLink: { href: "/sessions/01J8Z5/journal" },
  },
};

/** Without guidance the message is the only line under the title. */
export const MessageOnly: Story = {
  args: { guidance: undefined, code: undefined, retry: fn() },
};

export const WithRetryAndEvidenceDark: Story = {
  ...WithRetryAndEvidence,
  name: "With retry and evidence (dark)",
  globals: { theme: "dark" },
};

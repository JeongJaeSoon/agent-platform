import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorState } from "@werft-ai/ui";
import { fn } from "storybook/test";

const meta = {
  title: "States/ErrorState",
  component: ErrorState,
  args: { message: "session is closed", code: "SESSION_CLOSED" },
} satisfies Meta<typeof ErrorState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithRetryAndEvidence: Story = {
  args: {
    retry: fn(),
    evidenceLink: { href: "/sessions/01J8Z5/journal" },
  },
};

export const Forbidden: Story = {
  args: { message: "missing scope agents:write", code: "FORBIDDEN" },
};

/** A code with no guidance entry falls back to the generic instruction. */
export const UnknownCode: Story = {
  args: { message: "upstream exploded", code: "SOMETHING_NEW" },
};

export const WithRetryAndEvidenceDark: Story = {
  ...WithRetryAndEvidence,
  name: "With retry and evidence (dark)",
  globals: { theme: "dark" },
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiErrorState, SessionCounts } from "@werft-ai/react/components";

import { COUNTS, SLOTS } from "./operations-fixtures.ts";

/**
 * The operations overview's "now": sessions the viewer can read, by status,
 * each a link to the filtered session list. The slot line is the whole
 * installation's and only the operator sees it.
 */
const meta = {
  title: "Domain/Operations/SessionCounts",
  component: SessionCounts,
  args: {
    counts: COUNTS,
    slots: SLOTS,
    statusLink: (status, link) => (
      <a href={`#/sessions?status=${status}`} className={link.className}>
        {link.children}
      </a>
    ),
  },
} satisfies Meta<typeof SessionCounts>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllZero: Story = {
  args: {
    counts: {
      queued: 0,
      running: 0,
      needs_input: 0,
      idle: 0,
      failed: 0,
      stopped: 0,
    },
    slots: { used: 0, limit: 10 },
  },
};

export const SlotsFull: Story = { args: { slots: { used: 10, limit: 10 } } };

/** A member or admin: no slot line. */
export const MemberScope: Story = { args: { slots: undefined } };

export const Loading: Story = { args: { counts: undefined } };

export const ErrorState: Story = {
  name: "Error",
  args: {
    error: (
      <ApiErrorState
        title="세션 수를 읽지 못했습니다"
        message="upstream timeout"
        code="INTERNAL"
      />
    ),
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = {
  name: "Default (390px)",
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

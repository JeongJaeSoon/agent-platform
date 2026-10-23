import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReceiptLink, ReceiptSummary } from "@werft-ai/react/components";

// Fixed ids and times, as in the packages/ui gallery: no clocks, no randomness.
const SESSION_ID = "01J8Z5T7Q0000000000000000A";
const TURN_ID = "01J8Z5T7Q0000000000000000B";
const REQUEST_ID = "01J8Z5T7Q0000000000000000C";
const CREATED_AT = "2026-09-21T02:15:00.000Z";
const UPDATED_AT = "2026-09-21T02:15:42.000Z";

const meta = {
  title: "Domain/Receipt/ReceiptSummary",
  component: ReceiptSummary,
  args: {
    operation: "append_message",
    status: "accepted",
    target: {
      session_id: SESSION_ID,
      turn_id: TURN_ID,
      request_id: REQUEST_ID,
    },
    timestamps: { created_at: CREATED_AT, updated_at: CREATED_AT },
  },
} satisfies Meta<typeof ReceiptSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Accepted, with a link to the receipt. */
export const Default: Story = {
  args: {
    action: (
      <ReceiptLink
        receiptId="rcpt_01J8Z5"
        status="accepted"
        href="/receipts/rcpt_01J8Z5"
      />
    ),
  },
};

export const Unknown: Story = {
  args: {
    operation: "terminate",
    status: "unknown",
    target: { session_id: SESSION_ID, turn_id: null, request_id: null },
    timestamps: { created_at: CREATED_AT, updated_at: UPDATED_AT },
  },
};

export const Failed: Story = {
  name: "Error",
  args: {
    operation: "answer",
    status: "failed",
    target: { session_id: SESSION_ID, turn_id: TURN_ID, request_id: null },
    timestamps: { created_at: CREATED_AT, updated_at: UPDATED_AT },
    error: { code: "SESSION_PAUSED", message: "session is paused" },
  },
};

export const FailedDark: Story = {
  ...Failed,
  name: "Error (dark)",
  globals: { theme: "dark" },
};

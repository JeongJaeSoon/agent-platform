import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReceiptLink } from "@werft-ai/react/components";

const meta = {
  title: "Domain/Receipt/ReceiptLink",
  component: ReceiptLink,
  args: {
    receiptId: "rcpt_01J8Z5",
    status: "accepted",
    href: "/receipts/rcpt_01J8Z5",
  },
} satisfies Meta<typeof ReceiptLink>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Failed: Story = {
  name: "Error",
  args: {
    receiptId: "rcpt_01J8Z6",
    status: "failed",
    href: "/receipts/rcpt_01J8Z6",
  },
};

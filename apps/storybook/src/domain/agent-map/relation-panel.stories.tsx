import type { Meta, StoryObj } from "@storybook/react-vite";
import { RelationPanel } from "@werft-ai/react/agent-map";

import { NOW, selectedOf } from "./agent-map-fixtures.ts";

/** The selected session: header, the graph from md up (a tree below), timeline link. */
const meta = {
  title: "Domain/AgentMap/RelationPanel",
  component: RelationPanel,
  args: { ...selectedOf("s3"), now: NOW },
} satisfies Meta<typeof RelationPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};
export const Approval: Story = { args: selectedOf("s1") };
export const NoCallsYet: Story = {
  name: "No calls yet",
  args: selectedOf("s5"),
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { RelationTree } from "@werft-ai/react/agent-map";

import {
  MESSAGES,
  messageNodes,
  NODES,
  NOW,
  selectedOf,
} from "./agent-map-fixtures.ts";

/** Below md the relations are an indented list; message rows keep their badge. */
const meta = {
  title: "Domain/AgentMap/RelationTree",
  component: RelationTree,
  args: { ...selectedOf("s3"), now: NOW },
  render: (args) => (
    <div className="max-w-[358px]">
      <RelationTree {...args} />
    </div>
  ),
} satisfies Meta<typeof RelationTree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Delegation: Story = {};
export const WithMessages: Story = {
  name: "With messages",
  args: {
    ...selectedOf("s1"),
    nodes: [...(NODES.s1 ?? []), ...messageNodes(MESSAGES, "s1")],
  },
};

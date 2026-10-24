import type { Meta, StoryObj } from "@storybook/react-vite";
import { type MapNode, RunNode } from "@werft-ai/react/agent-map";

import { MESSAGES, messageNodes, NODES, NOW } from "./agent-map-fixtures.ts";

const ROWS: readonly MapNode[] = [
  ...(NODES.s1 ?? []),
  ...messageNodes(MESSAGES, "s1"),
];

/**
 * One row of the relation panel per edge kind: direct calls held on
 * approval, a delegated subagent (Task), and a session sent a request,
 * answering, or not answered yet. The tree layout drops only the Task badge.
 */
const meta = {
  title: "Domain/AgentMap/RunNode",
  component: RunNode,
  args: { node: ROWS[0] as MapNode, now: NOW },
  render: ({ layout }) =>
    layout === "tree" ? (
      <ul className="m-0 flex max-w-[360px] list-none flex-col gap-3 p-0">
        {ROWS.map((node) => (
          <RunNode key={node.id} node={node} layout="tree" now={NOW} />
        ))}
      </ul>
    ) : (
      <div className="flex max-w-[640px] flex-col gap-3">
        {ROWS.map((node) => (
          <RunNode key={node.id} node={node} now={NOW} />
        ))}
      </div>
    ),
} satisfies Meta<typeof RunNode>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EdgeKinds: Story = { name: "Edge kinds" };
export const Tree: Story = { args: { layout: "tree" } };

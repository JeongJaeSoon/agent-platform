import type { Meta, StoryObj } from "@storybook/react-vite";
import { RelationGraph } from "@werft-ai/react/agent-map";
import { expect, waitFor } from "storybook/test";

import {
  MESSAGES,
  messageNodes,
  NODES,
  NOW,
  selectedOf,
} from "./agent-map-fixtures.ts";

/**
 * The selected session's run on the left and one row per run or messaged
 * session on the right. Delegation keeps the design's line (a flowing dash
 * while the run works); a request points at the row, a response at the run,
 * an unanswered request is dotted, and an approval wait is the heavier
 * attention line. Each row names its edge in a badge.
 */
const meta = {
  title: "Domain/AgentMap/RelationGraph",
  component: RelationGraph,
  args: { ...selectedOf("s3"), now: NOW },
  render: (args) => (
    <div className="max-w-[920px]">
      <RelationGraph {...args} />
    </div>
  ),
} satisfies Meta<typeof RelationGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Delegation: Story = {};

export const AllEdgeKinds: Story = {
  name: "All edge kinds",
  args: {
    ...selectedOf("s1"),
    nodes: [...(NODES.s1 ?? []), ...messageNodes(MESSAGES, "s1")],
  },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelectorAll("path[data-edge]")).toHaveLength(5),
    );
    const kinds = [...canvasElement.querySelectorAll("path[data-edge]")].map(
      (path) => path.getAttribute("data-edge"),
    );
    await expect(kinds).toEqual([
      "approval",
      "delegation",
      "request",
      "response",
      "waiting",
    ]);
    for (const word of ["승인 대기", "Task", "요청", "응답", "응답 대기"])
      await expect(canvasElement).toHaveTextContent(word);
  },
};

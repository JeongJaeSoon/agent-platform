import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolChips } from "@werft-ai/react/agent-map";

/**
 * A run's latest tool calls. Success, failure, a running call and one held
 * on approval differ by the trailing mark and a hidden word, not by colour
 * alone; a tool outside the design's six gets the wrench.
 */
const meta = {
  title: "Domain/AgentMap/ToolChip",
  component: ToolChips,
  args: {
    tools: [
      { id: "1", name: "Read", target: "chart.tsx", state: "ok" },
      { id: "2", name: "Bash", target: "bun run storybook", state: "error" },
      { id: "3", name: "Grep", target: "aria-label", state: "running" },
      {
        id: "4",
        name: "Bash",
        target: "git push origin fix/webhook-retry",
        state: "waiting",
      },
      { id: "5", name: "Write", target: "notes.md", state: "ok" },
    ],
    hidden: 14,
  },
} satisfies Meta<typeof ToolChips>;

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {};
export const Empty: Story = { args: { tools: [], hidden: undefined } };
/**
 * Added by the coordinator's decision, not in the design: a call whose turn
 * or session ended before its result. No colour names it, so it says
 * "중단" on screen.
 */
export const Interrupted: Story = {
  args: {
    tools: [
      { id: "1", name: "Bash", target: "bun test", state: "interrupted" },
      { id: "2", name: "Read", target: "retry.ts", state: "ok" },
    ],
    hidden: undefined,
  },
};

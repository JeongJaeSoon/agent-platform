import type { Meta, StoryObj } from "@storybook/react-vite";
import { LaneBoard } from "@werft-ai/react/agent-map";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { DONE_COUNT, NOW, SESSIONS } from "./agent-map-fixtures.ts";

/**
 * Status lanes in the order a person acts on them, under the strip of open
 * requests (longest wait first). A card stays in its lane until the reader
 * tidies up; the pressed card is the one whose relations are open.
 */
const meta = {
  title: "Domain/AgentMap/LaneBoard",
  component: LaneBoard,
  args: {
    sessions: SESSIONS,
    doneCount: DONE_COUNT,
    selectedId: "s3",
    onSelect: () => {},
    now: NOW,
  },
  render: (args) => {
    const [selectedId, setSelectedId] = useState(args.selectedId);
    return (
      <div className="max-w-[360px]">
        <LaneBoard {...args} selectedId={selectedId} onSelect={setSelectedId} />
      </div>
    );
  },
} satisfies Meta<typeof LaneBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("button", { name: /주간 사용량 리포트/ });
    await userEvent.click(card);
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: /대시보드 차트 접근성/ }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const PinnedUntilTidy: Story = {
  name: "Pinned until tidy",
  args: {
    sessions: SESSIONS.map((s) =>
      s.id === "s4"
        ? {
            ...s,
            status: "needs_input" as const,
            pinnedLane: "running" as const,
            pending: { tool: "Bash · slack-post #ops", waitedMinutes: 0 },
          }
        : s,
    ),
  },
};

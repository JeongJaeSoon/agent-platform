import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentMap } from "@werft-ai/react/agent-map";
import { Button } from "@werft-ai/ui";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { DONE_COUNT, NOW, SESSIONS, selectedOf } from "./agent-map-fixtures.ts";

const WAITING = SESSIONS.filter((s) => s.pending).length;

/**
 * The board beside the selected session's relations. While the list loads,
 * stand-ins hold every place, the strip of open requests included, so the
 * lanes do not move when the data comes.
 */
const meta = {
  title: "Domain/AgentMap/AgentMap",
  component: AgentMap,
  args: {
    sessions: SESSIONS,
    doneCount: DONE_COUNT,
    selected: selectedOf("s3"),
    onSelect: () => {},
    now: NOW,
  },
} satisfies Meta<typeof AgentMap>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

const laneTop = (root: HTMLElement) =>
  [...root.querySelectorAll("h2")]
    .find((h) => h.textContent?.startsWith("답변 필요"))
    ?.getBoundingClientRect().top;

/** The list arrives with two open requests: the lanes stay where they stood. */
export const LoadingToData: Story = {
  name: "Loading → data (no shift)",
  render: (args) => {
    const [loading, setLoading] = useState(true);
    return (
      <div className="flex flex-col gap-4">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => setLoading(false)}
        >
          load
        </Button>
        <AgentMap {...args} loading={loading} waiting={WAITING} />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const before = laneTop(canvasElement);
    await expect(before).toBeGreaterThan(0);
    await userEvent.click(canvas.getByRole("button", { name: "load" }));
    await waitFor(() =>
      expect(
        canvas.getByRole("region", { name: "내 답변을 기다리는 요청" }),
      ).toBeInTheDocument(),
    );
    await expect(laneTop(canvasElement)).toBe(before);
  },
};

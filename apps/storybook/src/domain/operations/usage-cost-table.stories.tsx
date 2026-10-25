import type { Decorator, Meta, StoryObj } from "@storybook/react-vite";
import { UsageCostTable } from "@werft-ai/react/components";
import { expect } from "storybook/test";

import {
  breakdown,
  series,
  summaryOf,
} from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";

const split = breakdown(summaryOf(series(30)));

/**
 * GET /v1/usage/breakdown rows, largest cost first: a name over its share of
 * the cost, then sessions, tokens and cost.
 */
const meta = {
  title: "Domain/Operations/UsageCostTable",
  component: UsageCostTable,
  args: {
    label: "비용이 큰 에이전트",
    head: "에이전트",
    by: "agent",
    rows: split.agent.rows.slice(0, 3),
    tokens: false,
  },
} satisfies Meta<typeof UsageCostTable>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The overview's top three agents, without the token column. */
export const TopAgents: Story = {};

const BY_MODEL = {
  label: "모델별",
  head: "모델",
  by: "model",
  rows: split.model.rows,
  tokens: true,
} as const;

/** By model: the names in mono, the token column hidden below 460px. */
export const ByModel: Story = { args: BY_MODEL };

const width = (px: number): Decorator[] => [
  (Story) => (
    <div style={{ width: px }}>
      <Story />
    </div>
  ),
];

/**
 * Half of the usage tab's two-column row at 1280px with a classic scrollbar
 * (Windows, a mouse on macOS): 15px less than 1280 leaves the table 472px,
 * which keeps the design's token column.
 */
export const ByModelClassicScrollbar: Story = {
  name: "By model, 1280px with a classic scrollbar (472px)",
  args: BY_MODEL,
  decorators: width(472),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("columnheader", { name: "토큰" }),
    ).toBeVisible();
  },
};

/** A phone's table (390px less the page gutters) drops the token column. */
export const ByModelPhone: Story = {
  name: "By model, 390px (358px)",
  args: BY_MODEL,
  globals: MOBILE,
  decorators: width(358),
  play: async ({ canvas }) => {
    await expect(
      canvas.queryByRole("columnheader", { name: "토큰" }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("columnheader", { name: "비용" }),
    ).toBeVisible();
  },
};

/** Names without a space or hyphen wrap in their column; the figures keep theirs. */
export const LongNames: Story = {
  name: "Long names (390px)",
  args: {
    rows: split.agent.rows.slice(0, 2).map((row, i) => ({
      ...row,
      label:
        i === 0 ? "NightlyReleaseNotesAndChangelogWriterForPlatform" : null,
    })),
  },
  globals: MOBILE,
  // The 390 frame's body width, so the test runner (no viewport) sees it too.
  decorators: [
    (Story) => (
      <div style={{ width: 343 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    // The glyphs, not the span: an unbroken name overflows its box.
    const text = document.createRange();
    text.selectNodeContents(canvas.getByText(/^NightlyRelease/));
    const sessions = canvas.getAllByRole("cell").at(1) as HTMLElement;
    await expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
      sessions.getBoundingClientRect().left,
    );
    await expect(canvas.getByText("에이전트 없음")).toBeVisible();
  },
};

export const Empty: Story = { args: { rows: [] } };

export const Loading: Story = { args: { rows: undefined } };

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = {
  name: "By model (390px)",
  args: BY_MODEL,
  globals: MOBILE,
};

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

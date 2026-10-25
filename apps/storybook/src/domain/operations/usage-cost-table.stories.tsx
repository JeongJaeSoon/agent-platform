import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageCostTable } from "@werft-ai/react/components";

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

/** By model: the names in mono, the token column hidden below 480px. */
export const ByModel: Story = { args: BY_MODEL };

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

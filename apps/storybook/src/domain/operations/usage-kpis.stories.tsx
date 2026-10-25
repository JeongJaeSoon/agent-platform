import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageKpis } from "@werft-ai/react/components";

import { series, summaryOf } from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";

const SERIES = series(30);

/**
 * A period's sessions, run time, cost and tokens: GET /v1/usage/summary over
 * GET /v1/usage/series, one sparkline per card from its own field.
 */
const meta = {
  title: "Domain/Operations/UsageKpis",
  component: UsageKpis,
  args: { summary: summaryOf(SERIES), buckets: SERIES.buckets },
} satisfies Meta<typeof UsageKpis>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A turn without a reported cost: the cost card says it may be low. */
export const CostIncomplete: Story = {
  args: (() => {
    const partial = series(30, [5]);
    return { summary: summaryOf(partial), buckets: partial.buckets };
  })(),
};

export const Loading: Story = {
  args: { summary: undefined, buckets: undefined },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

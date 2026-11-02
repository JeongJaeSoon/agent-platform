import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageDailyCost } from "@werft-ai/react/components";

import { series } from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";

/**
 * Each day's estimated cost from GET /v1/usage/series; a day whose cost is
 * not all reported is hatched.
 */
const meta = {
  title: "Domain/Operations/UsageDailyCost",
  component: UsageDailyCost,
  args: { buckets: series(30).buckets, days: 30 },
} satisfies Meta<typeof UsageDailyCost>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SevenDays: Story = {
  args: { buckets: series(7).buckets, days: 7 },
};

/** Every day's cost reported: no hatched bar. */
export const AllReported: Story = {
  args: { buckets: series(30, []).buckets },
};

export const Loading: Story = { args: { buckets: undefined } };

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

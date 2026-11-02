import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageTokenMix } from "@werft-ai/react/components";

import {
  breakdown,
  series,
  summaryOf,
} from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";

/** The period's tokens from GET /v1/usage/breakdown `totals`, by kind. */
const TOTALS = breakdown(summaryOf(series(30))).model.totals;

const meta = {
  title: "Domain/Operations/UsageTokenMix",
  component: UsageTokenMix,
  args: { totals: TOTALS },
} satisfies Meta<typeof UsageTokenMix>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** No session in the period: every share is 0%. */
export const Empty: Story = {
  args: {
    totals: {
      ...TOTALS,
      token_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
};

export const Loading: Story = { args: { totals: undefined } };

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

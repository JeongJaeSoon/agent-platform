import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageBasis } from "@werft-ai/react/components";

import { series } from "../../screens/operations-fixtures.ts";
import { MOBILE } from "../../screens/screen-kit.tsx";

/** The line under the usage figures: whose usage, which UTC days, read when. */
const SERIES = series(30);

const meta = {
  title: "Domain/Operations/UsageBasis",
  component: UsageBasis,
  args: {
    scope: "installation",
    period: SERIES.period,
    refreshedAt: SERIES.refreshed_at,
    timeZone: "Asia/Seoul",
  },
} satisfies Meta<typeof UsageBasis>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A member sees only their own sessions' usage. */
export const OwnUsage: Story = { args: { scope: "me" } };

export const Loading: Story = { args: { refreshedAt: undefined } };

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolsFilter } from "@werft-ai/react/components";
import { fn } from "storybook/test";

import { MOBILE } from "../../screens/screen-kit.tsx";

/**
 * The tools tab's sort and search over the GET /v1/usage/tools rows; the
 * search reports its text once typing stops.
 */
const meta = {
  title: "Domain/Operations/ToolsFilter",
  component: ToolsFilter,
  args: { sort: "calls", onSortChange: fn(), onQueryChange: fn() },
} satisfies Meta<typeof ToolsFilter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ByFailures: Story = { args: { sort: "failed" } };

export const Dark: Story = { globals: { theme: "dark" } };

/** Below 640px the search takes its own line. */
export const Mobile: Story = { name: "Default (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

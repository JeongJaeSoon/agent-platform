import type { Meta, StoryObj } from "@storybook/react-vite";
import { OperationsHead } from "@werft-ai/react/components";

import { MOBILE } from "../../screens/screen-kit.tsx";

/** The operations menu's title and its tabs; the limits tab is the owner's. */
const meta = {
  title: "Domain/Operations/OperationsHead",
  component: OperationsHead,
  args: {
    tabs: ["overview", "usage", "tools", "limits"],
    current: "overview",
    tabLink: (tab, label) => <a href={`#operations/${tab}`}>{label}</a>,
  },
} satisfies Meta<typeof OperationsHead>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Owner: Story = {};

export const Member: Story = {
  args: { tabs: ["overview", "usage", "tools"], current: "usage" },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Owner (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

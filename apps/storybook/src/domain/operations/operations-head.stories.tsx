import type { Meta, StoryObj } from "@storybook/react-vite";
import { OperationsHead } from "@werft-ai/react/components";
import { expect, waitFor } from "storybook/test";

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

/** Tabs whose screens have not landed stay in place, inert, saying why. */
export const Soon: Story = {
  args: { soon: ["usage", "tools"] },
  play: async ({ canvas, userEvent }) => {
    const usage = canvas.getByRole("link", { name: "사용량" });
    await expect(usage).toHaveAttribute("aria-disabled", "true");
    await userEvent.tab();
    await userEvent.tab();
    await expect(usage).toHaveFocus();
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).toHaveTextContent("아직 준비 중인 화면입니다."),
    );
  },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Owner (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

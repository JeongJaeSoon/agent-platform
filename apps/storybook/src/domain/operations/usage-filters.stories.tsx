import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UsageSummaryScope } from "@werft-ai/contracts";
import { UsageFilters, type UsagePeriod } from "@werft-ai/react/components";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { MOBILE } from "../../screens/screen-kit.tsx";

function Picker({ operator }: { readonly operator: boolean }) {
  const [scope, setScope] = useState<UsageSummaryScope>("installation");
  const [days, setDays] = useState<UsagePeriod>(30);
  return (
    <UsageFilters
      {...(operator ? { scope, onScopeChange: setScope } : {})}
      days={days}
      onDaysChange={setDays}
    />
  );
}

/**
 * Whose usage and how many UTC days back. Only a viewer who may read the
 * installation's usage gets the scope choice; the period sits at the far end.
 */
const meta = {
  title: "Domain/Operations/UsageFilters",
  component: UsageFilters,
  args: { days: 30, onDaysChange: () => {} },
  render: (_, { parameters }) => (
    <Picker operator={parameters.operator !== false} />
  ),
} satisfies Meta<typeof UsageFilters>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Operator: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const week = canvas.getByRole("button", { name: "7일" });
    await userEvent.click(week);
    expect(week.getAttribute("aria-pressed")).toBe("true");
  },
};

/** A member or admin: their own usage only, so no scope choice. */
export const Member: Story = { parameters: { operator: false } };

export const Dark: Story = { globals: { theme: "dark" } };

export const Mobile: Story = { name: "Operator (390px)", globals: MOBILE };

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

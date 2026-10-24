import type { Meta, StoryObj } from "@storybook/react-vite";
import { FilterMenu } from "@werft-ai/ui";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

// The kit has no messages of its own; these stand in for apps/web's.
const RELATIONS = [
  { value: "all", label: "모든 관계" },
  { value: "started", label: "내가 시작" },
  { value: "shared", label: "공유받음" },
  { value: "administered", label: "관리하는 에이전트" },
];

const MOBILE = { viewport: { value: "mobile390", isRotated: false } };

function Relation({ initial }: { readonly initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <FilterMenu
      label="관계"
      options={RELATIONS}
      value={value}
      onValueChange={setValue}
    />
  );
}

const meta = {
  title: "Patterns/FilterMenu",
  component: FilterMenu,
  args: {
    label: "관계",
    options: RELATIONS,
    value: "all",
    onValueChange: () => undefined,
  },
  render: (args) => <Relation initial={args.value} />,
} satisfies Meta<typeof FilterMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Unfiltered: the name alone; the value is read, not shown. */
export const Default: Story = {};

export const DefaultDark: Story = {
  name: "Default (dark)",
  globals: { theme: "dark" },
};

/** Narrowed: the value shows on a filled chip. */
export const Filtered: Story = { args: { value: "started" } };

export const FilteredDark: Story = {
  ...Filtered,
  name: "Filtered (dark)",
  globals: { theme: "dark" },
};

/** Open on the current choice; arrows move, Enter picks and closes. */
export const KeyboardPick: Story = {
  play: async ({ canvasElement }) => {
    const chip = within(canvasElement).getByRole("button");
    chip.focus();
    await userEvent.keyboard("{Enter}");
    const page = within(document.body);
    await waitFor(() =>
      expect(page.getByRole("button", { name: "모든 관계" })).toHaveFocus(),
    );
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(chip).toHaveFocus());
    await expect(chip).toHaveAccessibleName("관계 내가 시작");
  },
};

/** Left open for the a11y run and screenshots. */
export const Open: Story = {
  args: { value: "shared" },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button"));
    await waitFor(() =>
      expect(within(document.body).getByRole("dialog")).toBeVisible(),
    );
  },
};

export const OpenMobileDark: Story = {
  ...Open,
  name: "Open (390px, dark)",
  globals: { ...MOBILE, theme: "dark" },
};

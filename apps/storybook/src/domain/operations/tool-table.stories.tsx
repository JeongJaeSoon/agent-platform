import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToolTable } from "@werft-ai/react/components";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import { TOOL_NOTE, TOOLS } from "./operations-fixtures.ts";

type Globals = { readonly globals: { readonly locale?: string } };
const lang = ({ globals }: Globals) =>
  globals.locale === "ja" || globals.locale === "en" ? globals.locale : "ko";

/**
 * GET /v1/usage/tools `tools` as a table. A row opens the tool in the rail;
 * its opener is pressed for the row shown. At 480px and under the two time
 * columns go and the name keeps its width.
 */
const meta = {
  title: "Domain/Operations/ToolTable",
  component: ToolTable,
  args: { tools: TOOLS.tools, label: "도구와 명령" },
  render: (args, context) => {
    const [selected, setSelected] = useState(args.selected);
    return (
      <div className="max-w-[640px]">
        <ToolTable
          {...args}
          selected={selected}
          onSelect={setSelected}
          describe={(name) => TOOL_NOTE[name]?.[lang(context)]}
        />
      </div>
    );
  },
} satisfies Meta<typeof ToolTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Selected: Story = {
  args: { selected: "Bash" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const read = canvas.getByRole("button", { name: "Read 자세히 보기" });
    read.focus();
    await userEvent.keyboard("{Enter}");
    await expect(read).toHaveAttribute("aria-pressed", "true");
    await expect(
      canvas.getByRole("button", { name: "Bash 자세히 보기" }),
    ).toHaveAttribute("aria-pressed", "false");
  },
};

export const SortedBySlowest: Story = {
  args: {
    tools: [...TOOLS.tools].sort((a, b) => b.median_ms - a.median_ms),
  },
};

export const Empty: Story = { args: { tools: [] } };

export const Loading: Story = { args: { tools: undefined } };

export const Mobile: Story = {
  name: "Default (390px)",
  args: { selected: "Bash" },
  globals: { viewport: { value: "mobile390", isRotated: false } },
};

export const Dark: Story = {
  args: { selected: "Bash" },
  globals: { theme: "dark" },
};

export const English: Story = { globals: { locale: "en" } };

export const Japanese: Story = { name: "日本語", globals: { locale: "ja" } };

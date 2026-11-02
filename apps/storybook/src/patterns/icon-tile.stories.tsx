import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconTile, type TileHue } from "@werft-ai/ui";
import {
  Bot,
  ClipboardCheck,
  Folder,
  Gauge,
  GitBranch,
  House,
  KeyRound,
  Users,
} from "lucide-react";

const HUES: readonly [TileHue, typeof Bot][] = [
  ["blue", House],
  ["violet", Bot],
  ["orange", Gauge],
  ["green", ClipboardCheck],
  ["pink", Users],
  ["teal", KeyRound],
  ["sky", GitBranch],
  ["slate", Folder],
];

const meta = {
  title: "Patterns/IconTile",
  component: IconTile,
  args: { icon: Bot, hue: "violet" },
} satisfies Meta<typeof IconTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** All eight hues, at the sidebar's one-line size and the home card's two-line size. */
export const Hues: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(["line", "two-line"] as const).map((size) => (
        <div key={size} className="flex flex-wrap items-center gap-3">
          {HUES.map(([hue, icon]) => (
            <IconTile key={hue} icon={icon} hue={hue} size={size} />
          ))}
        </div>
      ))}
    </div>
  ),
};

export const HuesDark: Story = {
  ...Hues,
  name: "Hues (dark)",
  globals: { theme: "dark" },
};

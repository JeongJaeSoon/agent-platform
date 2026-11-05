import type { ComponentType, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type TileHue =
  | "blue"
  | "violet"
  | "orange"
  | "green"
  | "pink"
  | "teal"
  | "sky"
  | "slate";

// Whole class names, so Tailwind finds each one in the source.
const HUE_CLASS: Record<TileHue, string> = {
  blue: "bg-(--werft-color-tile-blue)",
  violet: "bg-(--werft-color-tile-violet)",
  orange: "bg-(--werft-color-tile-orange)",
  green: "bg-(--werft-color-tile-green)",
  pink: "bg-(--werft-color-tile-pink)",
  teal: "bg-(--werft-color-tile-teal)",
  sky: "bg-(--werft-color-tile-sky)",
  slate: "bg-(--werft-color-tile-slate)",
};

export type TileIcon = ComponentType<{
  readonly className?: string;
  readonly strokeWidth?: number;
  readonly "aria-hidden"?: "true";
}>;

export type IconTileProps = {
  readonly icon: TileIcon;
  readonly hue: TileHue;
  readonly size?: "line" | "two-line" | undefined;
};

/**
 * A white glyph on a solid hue: the mark of a sidebar page and of a home card
 * about it. Beside two stacked lines it spans both (owner, 2026-11-02).
 */
export function IconTile({
  icon: Icon,
  hue,
  size = "line",
}: IconTileProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-slot="icon-tile"
      data-hue={hue}
      className={cn(
        "grid shrink-0 place-items-center rounded-control text-(--werft-color-tile-foreground)",
        size === "line"
          ? "size-(--werft-size-icon-tile)"
          : // Pinned to the first line when the text wraps past two.
            "size-(--werft-size-tile-two-line) self-start",
        HUE_CLASS[hue],
      )}
    >
      <Icon
        aria-hidden="true"
        strokeWidth={2}
        className={size === "line" ? "size-3.5" : "size-5"}
      />
    </span>
  );
}

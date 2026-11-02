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
  blue: "bg-(--ap-color-tile-blue)",
  violet: "bg-(--ap-color-tile-violet)",
  orange: "bg-(--ap-color-tile-orange)",
  green: "bg-(--ap-color-tile-green)",
  pink: "bg-(--ap-color-tile-pink)",
  teal: "bg-(--ap-color-tile-teal)",
  sky: "bg-(--ap-color-tile-sky)",
  slate: "bg-(--ap-color-tile-slate)",
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
        "grid shrink-0 place-items-center rounded-control text-(--ap-color-tile-foreground)",
        size === "line"
          ? "size-(--ap-size-icon-tile)"
          : // Pinned to the first line when the text wraps past two.
            "size-(--ap-size-tile-two-line) self-start",
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

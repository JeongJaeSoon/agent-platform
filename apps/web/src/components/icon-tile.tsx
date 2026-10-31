import { cn } from "@werft-ai/ui";
import type { ComponentType } from "react";

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

type TileIcon = ComponentType<{
  readonly className?: string;
  readonly strokeWidth?: number;
  readonly "aria-hidden"?: "true";
}>;

/**
 * A white glyph on a solid hue: the mark of a sidebar page and of a home card
 * about it, one size everywhere (owner, 2026-10-31).
 */
export function IconTile({
  icon: Icon,
  hue,
}: {
  readonly icon: TileIcon;
  readonly hue: TileHue;
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="icon-tile"
      data-hue={hue}
      className={cn(
        "grid size-(--ap-size-icon-tile) shrink-0 place-items-center rounded-control text-(--ap-color-tile-foreground)",
        HUE_CLASS[hue],
      )}
    >
      <Icon aria-hidden="true" strokeWidth={2} className="size-3.5" />
    </span>
  );
}

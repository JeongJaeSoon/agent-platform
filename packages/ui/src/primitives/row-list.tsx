import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps, JSX, ReactElement } from "react";

import { cn } from "../foundations/cn.ts";

/**
 * Lines stacked in one cell or list row: a 20px first line, then 16px lines,
 * a fixed gap apart.
 */
export function RowLines({
  className,
  ...props
}: ComponentProps<"span">): JSX.Element {
  return (
    <span
      data-slot="row-lines"
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-[var(--werft-row-line-gap)] [&>*:first-child]:leading-5 [&>*]:leading-4",
        className,
      )}
      {...props}
    />
  );
}

export type RowListProps = ComponentProps<"ul"> & {
  readonly variant?: "separate" | "joined";
  /**
   * `joined` only: the card frame around the rows, on by default. Off when
   * the list sits inside a frame of its own, beside an empty state.
   */
  readonly framed?: boolean | undefined;
};

/**
 * A list whose items are rows. `separate` draws each row as its own card;
 * `joined` draws one card with a rule between rows, like a table.
 */
export function RowList({
  variant = "separate",
  framed = true,
  className,
  ...props
}: RowListProps): JSX.Element {
  return (
    <ul
      data-slot="row-list"
      data-variant={variant}
      data-framed={(variant === "joined" && framed) || undefined}
      className={cn(
        "m-0 flex list-none flex-col p-0",
        variant === "separate"
          ? "gap-2 [&>li]:rounded-card [&>li]:border [&>li]:bg-card"
          : cn(
              "[&>li:last-child]:border-b-0 [&>li]:border-b",
              framed && "overflow-hidden rounded-card border bg-card",
            ),
        className,
      )}
      {...props}
    />
  );
}

export type RowListItemProps = ComponentProps<"li"> & {
  /**
   * The row opens as a whole through the RowLink inside it: it takes the
   * hover fill and the pointer, and the link's box stretches over it. Use it
   * only with a RowLink; in a `joined` list give the RowLink `inset`.
   */
  readonly opens?: boolean | undefined;
};

// A row that wraps on a narrow screen puts its action 8px under the text;
// the 2px line gap is only for lines inside RowLines.
export function RowListItem({
  opens = false,
  className,
  ...props
}: RowListItemProps): JSX.Element {
  return (
    <li
      data-slot="row-list-item"
      data-opens={opens || undefined}
      className={cn(
        "flex min-h-[var(--werft-row-min-height)] flex-wrap items-center gap-x-3 gap-y-2 px-[var(--werft-row-padding-x)] py-[var(--werft-row-padding-y)]",
        opens && OPENS_ROW,
        className,
      )}
      {...props}
    />
  );
}

/** Classes for any other box that opens as a whole through a RowLink. */
export const OPENS_ROW = "relative cursor-pointer hover:bg-hover";

export type RowLinkProps = {
  /** The row's one name link; its own text stays the link's name. */
  readonly children: ReactElement;
  /**
   * The keyboard ring sits inside the row, for a row in a frame that clips
   * its edge (a table). Otherwise it sits 2px outside, rounded like a card.
   */
  readonly inset?: boolean | undefined;
  readonly className?: string | undefined;
};

/**
 * The name link of a row that opens as a whole (RowListItem `opens`, or a box
 * with OPENS_ROW): its box stretches over the row, so the row keeps one link
 * and one Tab stop. Anything else in the row that takes a click sits above it
 * (`relative z-1`). `!` because styles.css rings every focused link outside
 * any layer, which beats a plain utility.
 */
export function RowLink({
  inset = false,
  className,
  ...props
}: RowLinkProps): JSX.Element {
  return (
    <Slot
      data-slot="row-link"
      className={cn(
        "after:absolute after:inset-0 focus-visible:outline-none! focus-visible:after:outline-2 focus-visible:after:outline-focus-ring",
        inset
          ? "focus-visible:after:-outline-offset-2"
          : "after:rounded-card focus-visible:after:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * The console's tables. Their spacing is the --ap-row-* tokens in tokens.css,
 * shared with the session table in @werft-ai/react.
 *
 * A table cell takes half the row inset on each side, so neighbours sit one
 * full inset apart like the grid rows' gap, and only the outer cells take the
 * full inset from the frame.
 */
const CELL_PADDING_X =
  "px-[calc(var(--ap-row-padding-x)/2)] first:pl-[var(--ap-row-padding-x)] last:pr-[var(--ap-row-padding-x)]";

/*
 * `actions` is a column of row buttons: as narrow as its content, never
 * wrapped, and every labelled button in it at least --ap-row-action-min-width
 * wide so the column does not jump when a label changes ("disable" ↔
 * "enable"). An icon button keeps its own square size.
 *
 * `nowrap` is a date, number or badge column: as narrow as its content and
 * never wrapped. `text` is the long-text column: it takes the width the other
 * columns leave, down to --ap-row-text-min-width, and the lines after the
 * first in its RowLines end in "…" instead of wrapping, so every row keeps one
 * height. `max-w-0` stops auto layout from widening the column to the text,
 * which is what lets the ellipsis appear. The ellipsis is visual only; give
 * the line a `title` with the full text (until Tooltip lands).
 */
const CELL_VARIANT = {
  default: "",
  actions:
    "w-px whitespace-nowrap [&_[data-slot=button]:not([data-size=icon])]:min-w-[var(--ap-row-action-min-width)]",
  nowrap: "w-px whitespace-nowrap",
  text: "w-full min-w-[var(--ap-row-text-min-width)] max-w-0 [&_[data-slot=row-lines]>*:not(:first-child)]:truncate",
} as const;

export type TableCellVariant = keyof typeof CELL_VARIANT;

export type TableContainerProps = ComponentProps<"section"> & {
  readonly label: string;
};

/**
 * The bordered frame a table sits in. It scrolls sideways when the table is
 * wider than the screen; the tab stop lets a keyboard reach it and scroll with
 * the arrow keys. Its focus ring is the console's (apps/web styles.css), drawn
 * here too so a host without that rule still shows where focus is.
 */
export function TableContainer({
  label,
  className,
  ...props
}: TableContainerProps): JSX.Element {
  return (
    <section
      data-slot="table-container"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard
      tabIndex={0}
      className={cn(
        "overflow-x-auto rounded-card border bg-card focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export function Table({
  className,
  ...props
}: ComponentProps<"table">): JSX.Element {
  return (
    <table
      data-slot="table"
      className={cn("w-full border-collapse text-control", className)}
      {...props}
    />
  );
}

export function TableHeader({
  className,
  ...props
}: ComponentProps<"thead">): JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn(
        "bg-surface-sunken [&>tr]:h-[var(--ap-row-head-min-height)]",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({
  className,
  ...props
}: ComponentProps<"tbody">): JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&>tr:last-child]:border-b-0", className)}
      {...props}
    />
  );
}

/** A table row's height is its floor, as min-height is for a block. */
export function TableRow({
  className,
  ...props
}: ComponentProps<"tr">): JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn("h-[var(--ap-row-min-height)] border-b", className)}
      {...props}
    />
  );
}

export type TableHeadProps = ComponentProps<"th"> & {
  readonly variant?: TableCellVariant;
};

export function TableHead({
  variant = "default",
  className,
  ...props
}: TableHeadProps): JSX.Element {
  return (
    <th
      data-slot="table-head"
      data-variant={variant}
      className={cn(
        CELL_PADDING_X,
        "py-[var(--ap-row-head-padding-y)] text-left align-middle font-medium text-caption text-muted-foreground",
        CELL_VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}

export type TableCellProps = ComponentProps<"td"> & {
  readonly variant?: TableCellVariant;
};

export function TableCell({
  variant = "default",
  className,
  ...props
}: TableCellProps): JSX.Element {
  return (
    <td
      data-slot="table-cell"
      data-variant={variant}
      className={cn(
        CELL_PADDING_X,
        "py-[var(--ap-row-padding-y)] text-left align-middle",
        CELL_VARIANT[variant],
        className,
      )}
      {...props}
    />
  );
}

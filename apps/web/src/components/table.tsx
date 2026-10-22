import { cn } from "@werft-ai/ui";
import type { ComponentProps, JSX } from "react";

/*
 * The console's tables and row lists. Their spacing is the --ap-row-* tokens
 * in tokens.css, shared with the session table in @werft-ai/ui.
 *
 * A table cell takes half the row inset on each side, so neighbours sit one
 * full inset apart like the grid rows' gap, and only the outer cells take the
 * full inset from the frame.
 */
const CELL_PADDING_X =
  "px-[calc(var(--ap-row-padding-x)/2)] first:pl-[var(--ap-row-padding-x)] last:pr-[var(--ap-row-padding-x)]";

/**
 * The bordered frame a table sits in. It scrolls sideways when the table is
 * wider than the screen; the tab stop lets a keyboard reach it and scroll with
 * the arrow keys.
 */
export function TableContainer({
  label,
  className,
  ...props
}: ComponentProps<"section"> & { readonly label: string }): JSX.Element {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll by keyboard
      tabIndex={0}
      className={cn("overflow-x-auto rounded-lg border bg-card", className)}
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
      className={cn("h-[var(--ap-row-min-height)] border-b", className)}
      {...props}
    />
  );
}

export function TableHead({
  className,
  ...props
}: ComponentProps<"th">): JSX.Element {
  return (
    <th
      className={cn(
        CELL_PADDING_X,
        "py-[var(--ap-row-head-padding-y)] text-left align-middle font-medium text-caption text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({
  className,
  ...props
}: ComponentProps<"td">): JSX.Element {
  return (
    <td
      className={cn(
        CELL_PADDING_X,
        "py-[var(--ap-row-padding-y)] text-left align-middle",
        className,
      )}
      {...props}
    />
  );
}

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
        "flex min-w-0 flex-1 flex-col gap-[var(--ap-row-line-gap)] [&>*:first-child]:leading-5 [&>*]:leading-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A list whose items are rows. `separate` draws each row as its own card;
 * `joined` draws one card with a rule between rows, like a table.
 */
export function RowList({
  variant = "separate",
  className,
  ...props
}: ComponentProps<"ul"> & {
  readonly variant?: "separate" | "joined";
}): JSX.Element {
  return (
    <ul
      data-variant={variant}
      className={cn(
        "m-0 flex list-none flex-col p-0",
        variant === "separate"
          ? "gap-2 [&>li]:rounded-md [&>li]:border [&>li]:bg-card"
          : "overflow-hidden rounded-lg border bg-card [&>li:last-child]:border-b-0 [&>li]:border-b",
        className,
      )}
      {...props}
    />
  );
}

export function RowListItem({
  className,
  ...props
}: ComponentProps<"li">): JSX.Element {
  return (
    <li
      className={cn(
        "flex min-h-[var(--ap-row-min-height)] flex-wrap items-center gap-x-3 gap-y-[var(--ap-row-line-gap)] px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]",
        className,
      )}
      {...props}
    />
  );
}

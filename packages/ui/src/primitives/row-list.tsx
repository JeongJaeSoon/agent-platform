import type { ComponentProps, JSX } from "react";

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
        "flex min-w-0 flex-1 flex-col gap-[var(--ap-row-line-gap)] [&>*:first-child]:leading-5 [&>*]:leading-4",
        className,
      )}
      {...props}
    />
  );
}

export type RowListProps = ComponentProps<"ul"> & {
  readonly variant?: "separate" | "joined";
};

/**
 * A list whose items are rows. `separate` draws each row as its own card;
 * `joined` draws one card with a rule between rows, like a table.
 */
export function RowList({
  variant = "separate",
  className,
  ...props
}: RowListProps): JSX.Element {
  return (
    <ul
      data-slot="row-list"
      data-variant={variant}
      className={cn(
        "m-0 flex list-none flex-col p-0",
        variant === "separate"
          ? "gap-2 [&>li]:rounded-card [&>li]:border [&>li]:bg-card"
          : "overflow-hidden rounded-card border bg-card [&>li:last-child]:border-b-0 [&>li]:border-b",
        className,
      )}
      {...props}
    />
  );
}

// A row that wraps on a narrow screen puts its action 8px under the text;
// the 2px line gap is only for lines inside RowLines.
export function RowListItem({
  className,
  ...props
}: ComponentProps<"li">): JSX.Element {
  return (
    <li
      data-slot="row-list-item"
      className={cn(
        "flex min-h-[var(--ap-row-min-height)] flex-wrap items-center gap-x-3 gap-y-2 px-[var(--ap-row-padding-x)] py-[var(--ap-row-padding-y)]",
        className,
      )}
      {...props}
    />
  );
}

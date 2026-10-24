import {
  type ComponentProps,
  Fragment,
  type JSX,
  type Key,
  type ReactNode,
} from "react";

import { cn } from "../foundations/cn.ts";

export interface KeyValueItem {
  readonly label: ReactNode;
  readonly value: ReactNode;
  /** A stable React key when labels are not unique strings. */
  readonly id?: Key | undefined;
}

export type KeyValueListProps = Omit<ComponentProps<"dl">, "children"> & {
  readonly items: readonly KeyValueItem[];
  /**
   * `list` (mockup v4 `.kv-list`): label left, value right, 4px apart, for a
   * card's summary. `grid` (`.dl`): a 140px label column, for a detail page.
   */
  readonly variant?: "list" | "grid" | undefined;
};

/** Labelled values as a `<dl>`, in either of mockup v4's two layouts. */
export function KeyValueList({
  items,
  variant = "list",
  className,
  ...props
}: KeyValueListProps): JSX.Element {
  const keyOf = (item: KeyValueItem, index: number): Key =>
    item.id ?? (typeof item.label === "string" ? item.label : index);
  if (variant === "grid") {
    return (
      <dl
        data-slot="key-value-list"
        data-variant="grid"
        className={cn(
          "m-0 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 text-control",
          className,
        )}
        {...props}
      >
        {items.map((item, index) => (
          <Fragment key={keyOf(item, index)}>
            <dt className="text-muted-foreground">{item.label}</dt>
            <dd className="m-0 flex min-w-0 flex-wrap items-center gap-2">
              {item.value}
            </dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  return (
    <dl
      data-slot="key-value-list"
      data-variant="list"
      className={cn("m-0 flex flex-col gap-1", className)}
      {...props}
    >
      {items.map((item, index) => (
        <div
          key={keyOf(item, index)}
          className="flex min-h-6 items-center justify-between gap-3 text-control"
        >
          <dt className="flex-none whitespace-nowrap text-muted-foreground">
            {item.label}
          </dt>
          <dd className="m-0 inline-flex min-w-0 items-center justify-end gap-2 text-right tabular-nums">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

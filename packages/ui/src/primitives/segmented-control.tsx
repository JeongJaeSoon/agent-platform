import {
  type ComponentProps,
  createContext,
  type JSX,
  type ReactNode,
  useContext,
} from "react";

import { cn } from "../foundations/cn.ts";

/*
 * Console v4 `.seg`: one choice out of a few, such as a list filter or a
 * card/table view switch. The items are toggle buttons in a named group, each
 * a Tab stop of its own, not a tablist: picking one filters what is already
 * on screen instead of showing another panel. Too many items wrap inside the
 * track rather than scroll, so no scroll box clips a focus outline.
 */

type SegmentedControlContextValue = {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

const SegmentedControlContext =
  createContext<SegmentedControlContextValue | null>(null);

export type SegmentedControlProps = Omit<
  ComponentProps<"div">,
  "aria-label" | "role" | "defaultValue" | "onChange"
> & {
  /** Names the choice for screen readers, e.g. "세션 상태". */
  readonly "aria-label": string;
  /** The `value` of the pressed item. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
};

export function SegmentedControl({
  className,
  value,
  onValueChange,
  ...props
}: SegmentedControlProps): JSX.Element {
  return (
    <SegmentedControlContext.Provider value={{ value, onValueChange }}>
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would need a visible legend; v4 names the group with aria-label. */}
      <div
        role="group"
        data-slot="segmented-control"
        className={cn(
          "inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-card border border-border bg-card p-0.5",
          className,
        )}
        {...props}
      />
    </SegmentedControlContext.Provider>
  );
}

export type SegmentedControlItemProps = Omit<
  ComponentProps<"button">,
  "type" | "value" | "aria-pressed"
> & {
  readonly value: string;
  /** Drawn after the label, 0 included; omit for no count. */
  readonly count?: number | undefined;
  /**
   * Screen-reader text for the count, e.g. "3개 실행 중". Without it the
   * number itself is read after the label.
   */
  readonly countLabel?: ReactNode | undefined;
};

export function SegmentedControlItem({
  className,
  value,
  count,
  countLabel,
  onClick,
  children,
  ...props
}: SegmentedControlItemProps): JSX.Element {
  const group = useContext(SegmentedControlContext);
  if (group === null) {
    throw new Error("SegmentedControlItem must be inside a SegmentedControl");
  }
  return (
    <button
      type="button"
      data-slot="segmented-control-item"
      aria-pressed={group.value === value}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) group.onValueChange(value);
      }}
      className={cn(
        "inline-flex h-[var(--ap-control-height-sm)] items-center gap-2 whitespace-nowrap rounded-control border-0 bg-transparent px-2 font-medium text-control text-muted-foreground hover:text-foreground",
        "aria-pressed:bg-active aria-pressed:text-foreground",
        // v4 keeps the count text-3, but on the pressed fill that is 4.47:1;
        // text-2 keeps it at AA.
        "aria-pressed:[&_[data-slot=item-count]]:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <ItemCount count={count} countLabel={countLabel} />
    </button>
  );
}

/**
 * The v4 `.seg-count` after a segment, tab or route tab label. The space keeps
 * the label and the number apart in the accessible name; flex drops it from
 * the layout, and the screen-reader text is out of flow, so the gap before
 * the number is the item's own.
 */
export function ItemCount({
  count,
  countLabel,
}: {
  readonly count: number | undefined;
  readonly countLabel: ReactNode | undefined;
}): ReactNode {
  if (count === undefined) return null;
  const hasLabel = countLabel !== undefined && countLabel !== null;
  return (
    <>
      {" "}
      <span
        data-slot="item-count"
        aria-hidden={hasLabel ? "true" : undefined}
        className="text-caption text-subtle-foreground tabular-nums"
      >
        {count}
      </span>
      {hasLabel ? <span className="sr-only">{countLabel}</span> : null}
    </>
  );
}

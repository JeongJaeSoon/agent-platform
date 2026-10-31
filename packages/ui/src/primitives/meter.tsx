import type { ComponentProps, CSSProperties, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type MeterProps = Omit<
  ComponentProps<"span">,
  "role" | "children" | "aria-label"
> & {
  readonly value: number;
  /** The value of a full bar; zero or less draws an empty one. */
  readonly max: number;
  /** Names what is measured, e.g. "동시 실행 slot 사용률". */
  readonly label: string;
  /** `inline` is the thin bar under a table cell's text. */
  readonly size?: "default" | "inline" | undefined;
  /** A share close to its limit. */
  readonly tone?: "caution" | undefined;
};

/** A share of a whole as a bar; the figure itself is the text beside it. */
export function Meter({
  value,
  max,
  label,
  size = "default",
  tone,
  className,
  ...props
}: MeterProps): JSX.Element {
  const limit = Math.max(0, max);
  const now = Math.min(limit, Math.max(0, value));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> draws its own bar per browser; the track and mark are tokens.
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={now}
      data-slot="meter"
      data-size={size}
      className={cn(
        "block overflow-hidden rounded-full bg-chart-track",
        size === "inline" ? "h-1" : "h-2",
        className,
      )}
      {...props}
    >
      <span
        data-slot="meter-mark"
        className={cn(
          "block h-full w-(--meter-share) rounded-full",
          tone === "caution"
            ? "bg-(color:--ap-tone-caution-fg)"
            : "bg-chart-mark",
        )}
        style={
          {
            "--meter-share": `${limit > 0 ? (now / limit) * 100 : 0}%`,
          } as CSSProperties
        }
      />
    </span>
  );
}

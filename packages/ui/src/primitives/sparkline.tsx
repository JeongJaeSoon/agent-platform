import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type SparklineProps = Omit<
  ComponentProps<"svg">,
  "role" | "children" | "aria-label" | "values"
> & {
  /** Oldest first, one per period. */
  readonly values: readonly number[];
  /** Names the trend, e.g. "일자별 세션 수"; the figure beside it says the value. */
  readonly label: string;
};

// The plot is 100 × 32 stretched to its box; the line keeps 2px under the
// top edge and stops 2px above the bottom, where a flat series lies.
const WIDTH = 100;
const HEIGHT = 32;
const BASE = 30;
const RANGE = 28;

function points(values: readonly number[]): string[] {
  // One value still draws a line, flat across the box.
  const series = values.length === 1 ? [...values, ...values] : values;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  return series.map((value, index) => {
    const x = (index / (series.length - 1)) * WIDTH;
    const y = BASE - ((value - min) / span) * RANGE;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
}

/** A trend line with the area under it, no axes. */
export function Sparkline({
  values,
  label,
  className,
  ...props
}: SparklineProps): JSX.Element {
  const line = values.length > 0 ? points(values) : [];
  return (
    <svg
      role="img"
      aria-label={label}
      data-slot="sparkline"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn("block h-8 w-full", className)}
      {...props}
    >
      {line.length > 0 ? (
        <>
          <polygon
            className="fill-chart-track stroke-none"
            points={`0,${HEIGHT} ${line.join(" ")} ${WIDTH},${HEIGHT}`}
          />
          <polyline
            className="fill-none stroke-2 stroke-chart-mark"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            points={line.join(" ")}
          />
        </>
      ) : null}
    </svg>
  );
}

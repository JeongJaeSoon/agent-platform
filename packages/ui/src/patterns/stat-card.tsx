import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";
import { Card } from "../primitives/card.tsx";

export type StatCardProps = Omit<ComponentProps<"div">, "children"> & {
  readonly label: ReactNode;
  /** The figure, formatted by the caller. */
  readonly value: ReactNode;
  /** A Badge beside the label, such as the period it covers. */
  readonly badge?: ReactNode | undefined;
  /** One meta line under the figure. */
  readonly description?: ReactNode | undefined;
  /** Greys the figure, for a value that is empty or not yet counted. */
  readonly muted?: boolean | undefined;
};

/** One KPI card (mockup v4 `.kpi-label`, `.kpi-num`, `.meta`). */
export function StatCard({
  label,
  value,
  badge,
  description,
  muted = false,
  className,
  ...props
}: StatCardProps): JSX.Element {
  return (
    <Card data-slot="stat-card" className={cn("min-w-0", className)} {...props}>
      <div className="flex items-center gap-2 px-4 text-control text-muted-foreground">
        {label}
        {badge}
      </div>
      <div
        className={cn(
          "px-4 font-semibold text-number tracking-[-0.5px] tabular-nums",
          muted && "text-subtle-foreground",
        )}
      >
        {value}
      </div>
      {description ? (
        <div className="px-4 text-caption text-subtle-foreground leading-normal">
          {description}
        </div>
      ) : null}
    </Card>
  );
}

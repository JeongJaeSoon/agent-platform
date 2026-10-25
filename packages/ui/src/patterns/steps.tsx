import type { JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * A to-do checklist, not navigation: each row is done or not on its own and
 * may carry its own action (the screen passes the button). Unlike `Stepper`
 * there is no current step and no keyboard model of its own.
 */

export interface StepsItem {
  readonly id: string;
  readonly title: ReactNode;
  readonly description?: ReactNode | undefined;
  readonly done?: boolean | undefined;
  /** Shown at the row's right end, e.g. a small `Button`. */
  readonly action?: ReactNode | undefined;
}

export interface StepsProps {
  readonly items: readonly StepsItem[];
  /** Read out after each done item; the circle's check mark is not. */
  readonly completedLabel?: string | undefined;
  readonly className?: string | undefined;
}

export function Steps({
  items,
  completedLabel = "완료",
  className,
}: StepsProps): JSX.Element {
  return (
    <ol data-slot="steps" className={cn("flex flex-col", className)}>
      {items.map((item, index) => (
        <li
          key={item.id}
          data-slot="steps-item"
          data-state={item.done ? "done" : "todo"}
          className="flex items-center gap-3 border-t py-3 break-keep first:border-t-0 first:pt-0 last:pb-0"
        >
          <span
            aria-hidden="true"
            className={cn(
              "grid size-6 flex-none place-content-center rounded-full border font-semibold text-xs",
              item.done
                ? "border-(color:--ap-tone-success-border) bg-(color:--ap-tone-success-bg) text-(color:--ap-tone-success-fg)"
                : "border-border-strong text-muted-foreground",
            )}
          >
            {item.done ? "✓" : index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-control">
              {item.title}
              {item.done ? (
                <span className="sr-only">, {completedLabel}</span>
              ) : null}
            </span>
            {item.description ? (
              <span className="text-caption text-subtle-foreground leading-normal">
                {item.description}
              </span>
            ) : null}
          </div>
          {item.action}
        </li>
      ))}
    </ol>
  );
}

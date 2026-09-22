import type { JSX, ReactNode } from "react";

import { cn } from "../lib/cn.ts";

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string | undefined;
  /** Primary way out of the empty screen. */
  readonly action?: ReactNode | undefined;
  readonly secondaryAction?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/**
 * Nothing here yet — calm, not alarming. `ErrorState` is the one that raises its
 * voice; the two must never look alike (§5 "보고할 것이 없으면 조용하다").
 */
export function EmptyState({
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div className={cn("ap-state", "ap-state--empty", className)}>
      <p className="ap-state__title">{title}</p>
      {description ? (
        <p className="ap-state__description">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="ap-state__actions">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

import type { JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string | undefined;
  /** Primary way out of the empty screen. */
  readonly action?: ReactNode | undefined;
  readonly secondaryAction?: ReactNode | undefined;
  /** A 16px icon, drawn in a quiet 40px box above the title. */
  readonly icon?: ReactNode | undefined;
  /** `sm` sits inside a card or a list, with less room around it. */
  readonly size?: "default" | "sm" | undefined;
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
  icon,
  size = "default",
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn("ap-state", "ap-state--empty", className)}
      data-size={size}
    >
      {icon ? (
        <span className="ap-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
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

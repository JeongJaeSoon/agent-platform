import type { JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../primitives/tooltip.tsx";

export interface DisabledReasonProps {
  /** Why the control inside is unavailable. */
  readonly reason: ReactNode;
  /** The disabled control. */
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/**
 * Says why a disabled control is unavailable, on hover or keyboard focus,
 * without moving it: a disabled button takes neither focus nor the pointer,
 * so the box around it takes both and carries the reason as its description.
 * The note opens above, where it covers no row below.
 */
export function DisabledReason({
  reason,
  children,
  className,
}: DisabledReasonProps): JSX.Element {
  return (
    <Tooltip>
      {/* Radix sets type="button" on its trigger, which a span does not take. */}
      <TooltipTrigger asChild={true} type={undefined}>
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled control inside cannot take focus, so its reason is reached here
          tabIndex={0}
          data-slot="disabled-reason"
          className={cn(
            "inline-flex shrink-0 rounded-control focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
            className,
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  );
}

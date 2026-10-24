import {
  cloneElement,
  type JSX,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";

import { cn } from "../foundations/cn.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../primitives/tooltip.tsx";

export interface DisabledReasonProps {
  /** Why the control inside is unavailable. */
  readonly reason: ReactNode;
  /** The withheld action, e.g. "Disable Alex"; the box is read by it. */
  readonly label: string;
  /** The disabled control. */
  readonly children: ReactElement<{ "aria-describedby"?: string }>;
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
  label,
  children,
  className,
}: DisabledReasonProps): JSX.Element {
  const reasonId = useId();
  // Reading the page line by line reaches the control, not the box.
  const control = cloneElement(children, {
    "aria-describedby": [children.props["aria-describedby"], reasonId]
      .filter(Boolean)
      .join(" "),
  });
  return (
    <Tooltip>
      {/* Radix sets type="button" on its trigger, which a span does not take. */}
      <TooltipTrigger asChild={true} type={undefined}>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset is a form block, this is an inline box in a row */}
        <span
          role="group"
          aria-label={label}
          aria-disabled={true}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the disabled control inside cannot take focus, so its reason is reached here
          tabIndex={0}
          data-slot="disabled-reason"
          className={cn(
            "inline-flex shrink-0 rounded-control focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-2",
            className,
          )}
        >
          {control}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
      <span id={reasonId} hidden={true}>
        {reason}
      </span>
    </Tooltip>
  );
}

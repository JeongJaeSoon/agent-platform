import { Button, Popover, PopoverContent, PopoverTrigger } from "@werft-ai/ui";
import { Info } from "lucide-react";

/**
 * A withheld action's reason behind an info button, for table rows that must
 * keep one height: the reason under the control would stretch its row. The
 * hidden copy carries `id`, so the disabled control can be described by it.
 */
export function ReasonHint({
  id,
  label,
  reason,
}: {
  readonly id: string;
  /** What the button opens, e.g. why the action is unavailable. */
  readonly label: string;
  readonly reason: string;
}) {
  return (
    // Positioned, so the absolutely placed hidden copy stays inside a table's
    // scroll container instead of widening the page past it.
    <span className="relative inline-flex">
      <span id={id} className="ap-visually-hidden">
        {reason}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-[var(--ap-control-height-sm)]"
            aria-label={label}
          >
            <Info aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        {/* Radix moves focus into this dialog; it is named like its button. */}
        <PopoverContent aria-label={label}>{reason}</PopoverContent>
      </Popover>
    </span>
  );
}

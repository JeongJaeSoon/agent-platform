import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type { ComponentProps, JSX } from "react";

import { cn } from "../lib/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york Checkbox. Changed from upstream: Field wiring (put each
 * checkbox in its own horizontal Field with its FieldLabel), an inline check
 * instead of lucide-react, card background, no `dark:` variants, and the box
 * drawn in `muted-foreground`: the outline is all that shows an unchecked box,
 * and `border-input` is under 3:1 against the canvas in both themes.
 */
export function Checkbox({
  className,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root>): JSX.Element {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-muted-foreground bg-card shadow-xs outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground motion-reduce:transition-none",
        className,
      )}
      {...useFieldControl(props)}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <Check className="size-3.5" strokeWidth={2} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

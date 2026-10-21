import type { ComponentProps, JSX } from "react";

import { cn } from "../lib/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york Textarea. Changed from upstream as Input is: Field wiring,
 * card background, no `dark:` variants, no transition under reduced motion.
 */
export function Textarea({
  className,
  ...props
}: ComponentProps<"textarea">): JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "field-sizing-content flex min-h-16 w-full rounded-md border border-input bg-card px-3 py-2 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none md:text-sm",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...useFieldControl(props)}
    />
  );
}

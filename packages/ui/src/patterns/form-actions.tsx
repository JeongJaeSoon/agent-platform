import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/**
 * The button row under an inline form: end-aligned, wrapping on a narrow
 * screen. A child with `mr-auto` (a note) keeps to the start. Not
 * `CardFooter variant="form"`, which is a sunken band across a card's foot.
 */
export function FormActions({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="form-actions"
      className={cn("flex flex-wrap items-center justify-end gap-2", className)}
      {...props}
    />
  );
}

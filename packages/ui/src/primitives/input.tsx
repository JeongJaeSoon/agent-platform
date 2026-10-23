import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york Input. Changed from upstream: inside a Field it takes the
 * Field's id and ARIA (field.tsx), the background is the card surface instead
 * of transparent so it reads on the canvas, there are no `dark:` variants, and
 * transitions stop under reduced motion.
 */
export function Input({
  className,
  type,
  ...props
}: ComponentProps<"input">): JSX.Element {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[var(--ap-control-height)] w-full min-w-0 rounded-control border border-input bg-card px-3 py-1 text-control outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-[var(--ap-control-height-sm)] file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-body placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...useFieldControl(props)}
    />
  );
}

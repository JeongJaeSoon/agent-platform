import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useFieldControl } from "./field.tsx";

export type SwitchProps = ComponentProps<typeof SwitchPrimitive.Root>;

/*
 * shadcn/ui new-york Switch. Changed from upstream: Field wiring (a FieldLabel
 * names it, a FieldDescription describes it), a 20×36 track so the thumb sits
 * on the 4px grid, the console's focus outline instead of a ring, the off
 * track in `input` (the control boundary needs 3:1 against the card), a card
 * thumb when off, no thumb shadow and no `dark:` variants. The state is
 * `aria-checked`; any "on"/"off" words belong to the caller, outside.
 */
export function Switch({ className, ...props }: SwitchProps): JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-[background-color] duration-[var(--ap-motion-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input motion-reduce:transition-none",
        className,
      )}
      {...useFieldControl(props)}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full transition-transform duration-[var(--ap-motion-fast)] data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 data-[state=checked]:bg-primary-foreground data-[state=unchecked]:bg-card motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}

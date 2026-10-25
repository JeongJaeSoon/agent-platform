import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * shadcn/ui new-york Popover without tw-animate-css classes. It opens on a
 * click, a tap or Enter and closes on Escape, so a short note behind an
 * icon reaches touch and keyboard users alike, which a hover tooltip does not.
 */

export function Popover(
  props: ComponentProps<typeof PopoverPrimitive.Root>,
): JSX.Element {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(
  props: ComponentProps<typeof PopoverPrimitive.Trigger>,
): JSX.Element {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** Positions the content against this element instead of the trigger. */
export function PopoverAnchor(
  props: ComponentProps<typeof PopoverPrimitive.Anchor>,
): JSX.Element {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export function PopoverContent({
  className,
  sideOffset = 4,
  // The 1rem that max-w leaves on each side, kept when it slides off an edge.
  collisionPadding = 16,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>): JSX.Element {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "z-50 max-w-[min(20rem,calc(100vw-2rem))] rounded-card border bg-popover px-3 py-2 text-caption text-popover-foreground shadow-pop outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

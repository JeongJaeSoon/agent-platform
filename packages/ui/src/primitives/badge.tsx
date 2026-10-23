import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { StatusDot, type StatusDotStatus } from "./status-dot.tsx";

/*
 * shadcn/ui new-york Badge, without `dark:` variants (see button.tsx). A badge
 * names a category; a status with meaning (running, paused…) is StatusLabel.
 * The five colour variants are console v35's badge tones.
 */
export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap h-5 rounded-full border px-2 font-medium text-caption transition-[color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring motion-reduce:transition-none [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        gray: "border-(color:--ap-tone-neutral-border) bg-(color:--ap-tone-neutral-bg) text-(color:--ap-tone-neutral-fg)",
        blue: "border-(color:--ap-tone-progress-border) bg-(color:--ap-tone-progress-bg) text-(color:--ap-tone-progress-fg)",
        green:
          "border-(color:--ap-tone-success-border) bg-(color:--ap-tone-success-bg) text-(color:--ap-tone-success-fg)",
        amber:
          "border-(color:--ap-tone-caution-border) bg-(color:--ap-tone-caution-bg) text-(color:--ap-tone-caution-fg)",
        red: "border-(color:--ap-tone-danger-border) bg-(color:--ap-tone-danger-bg) text-(color:--ap-tone-danger-fg)",
        // An identifier such as a model name; grey like `gray` (mockup v4).
        mono: "border-(color:--ap-tone-neutral-border) bg-(color:--ap-tone-neutral-bg) font-mono font-normal text-(color:--ap-tone-neutral-fg)",
      },
    },
    defaultVariants: { variant: "gray" },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    readonly asChild?: boolean;
    /**
     * A status dot before the label (mockup v4's session head). Not drawn
     * with `asChild`, whose one child is the badge.
     */
    readonly dot?: StatusDotStatus | undefined;
  };

export function Badge({
  className,
  variant,
  asChild = false,
  dot,
  children,
  ...props
}: BadgeProps): JSX.Element {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {dot ? <StatusDot status={dot} /> : null}
          {children}
        </>
      )}
    </Comp>
  );
}

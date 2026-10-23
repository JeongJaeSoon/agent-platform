import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

/** Mockup v4's `.avatar`: initials on a fill, no image. */
export const avatarVariants = cva(
  "inline-grid flex-none select-none place-items-center font-semibold",
  {
    variants: {
      size: {
        default: "size-6 text-2xs",
        lg: "size-8 text-caption",
      },
      shape: {
        circle: "rounded-full",
        square: "rounded-control",
      },
      tone: {
        default: "bg-active text-muted-foreground",
        1: "bg-(color:--ap-avatar-1-bg) text-(color:--ap-avatar-1-fg)",
        2: "bg-(color:--ap-avatar-2-bg) text-(color:--ap-avatar-2-fg)",
        3: "bg-(color:--ap-avatar-3-bg) text-(color:--ap-avatar-3-fg)",
        4: "bg-(color:--ap-avatar-4-bg) text-(color:--ap-avatar-4-fg)",
      },
    },
    defaultVariants: { size: "default", shape: "circle", tone: "default" },
  },
);

export type AvatarProps = Omit<ComponentProps<"span">, "children"> &
  VariantProps<typeof avatarVariants> & {
    /** One or two letters; the name itself goes in `label` or beside it. */
    readonly initials: string;
    /**
     * The person or agent's name, for an avatar shown without its name
     * beside it. Left out, the avatar is decoration and screen readers skip
     * it, so the visible name is not read twice.
     */
    readonly label?: string | undefined;
  };

export function Avatar({
  className,
  size,
  shape,
  tone,
  initials,
  label,
  ...props
}: AvatarProps): JSX.Element {
  const named = label !== undefined && label !== "";
  return (
    <span
      data-slot="avatar"
      className={cn(avatarVariants({ size, shape, tone }), className)}
      {...(named
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      {...props}
    >
      {initials}
    </span>
  );
}

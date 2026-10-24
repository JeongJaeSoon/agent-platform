import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";

import { cn } from "../foundations/cn.ts";

/*
 * shadcn/ui new-york Alert with mockup v4's `.banner` values. Unlike upstream
 * it has no default `role="alert"`: most banners are standing notes, and a
 * live region would be read out every time the page opens. The caller passes
 * `role="alert"` or `role="status"` when the box reports something new.
 */
export const alertVariants = cva(
  "flex items-start gap-2 rounded-card border px-4 py-3 text-description text-muted-foreground",
  {
    variants: {
      variant: {
        default: "border-border bg-card",
        blue: "border-(color:--ap-tone-progress-border) bg-(color:--ap-tone-progress-bg)",
        amber:
          "border-(color:--ap-tone-caution-border) bg-(color:--ap-tone-caution-bg)",
        red: "border-(color:--ap-tone-danger-border) bg-(color:--ap-tone-danger-bg)",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

// Only the icon takes the tone's colour; the text stays text-2 and text.
const ICON: Record<AlertVariant, { Icon: typeof Info; color: string }> = {
  default: { Icon: Info, color: "" },
  blue: { Icon: Info, color: "text-(color:--ap-tone-progress-fg)" },
  amber: { Icon: TriangleAlert, color: "text-(color:--ap-tone-caution-fg)" },
  red: { Icon: CircleAlert, color: "text-(color:--ap-tone-danger-fg)" },
};

export type AlertProps = ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & {
    /**
     * Decorative, so hidden from screen readers. Left out, the variant's own
     * icon; `null` draws none.
     */
    readonly icon?: ReactNode;
    /** Render the single child (an `<output>`, a `<section>`) as the box. */
    readonly asChild?: boolean;
  };

export function Alert({
  className,
  variant,
  icon,
  asChild = false,
  children,
  ...props
}: AlertProps): JSX.Element {
  const { Icon, color } = ICON[variant ?? "default"];
  const Comp = asChild ? Slot : "div";
  const content = (inner: ReactNode) => (
    <div
      data-slot="alert-content"
      className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]"
    >
      {inner}
    </div>
  );
  return (
    <Comp
      data-slot="alert"
      data-variant={variant ?? "default"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {icon === null ? null : (
        <span
          data-slot="alert-icon"
          aria-hidden="true"
          className={cn("mt-0.5 flex size-4 flex-none [&>svg]:size-4", color)}
        >
          {icon === undefined ? <Icon strokeWidth={1.5} /> : icon}
        </span>
      )}
      {asChild ? (
        <Slottable child={children}>{content}</Slottable>
      ) : (
        content(children)
      )}
    </Comp>
  );
}

export type AlertTitleProps = ComponentProps<"div"> & {
  /** Render the single child (a heading) as the title. */
  readonly asChild?: boolean;
};

export function AlertTitle({
  className,
  asChild = false,
  ...props
}: AlertTitleProps): JSX.Element {
  const Comp = asChild ? Slot : "div";
  return (
    <Comp
      data-slot="alert-title"
      className={cn("font-medium text-description text-foreground", className)}
      {...props}
    />
  );
}

export function AlertDescription({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

/** Buttons under the text, 8px below it (mockup v4's new-key banner). */
export function AlertActions({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="alert-actions"
      className={cn("mt-1.5 flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type CardProps = ComponentProps<"div"> & {
  /**
   * No padding or gap (mockup v4 `.card.flush`): the body pads itself and a
   * `CardFooter variant="form"` runs edge to edge.
   */
  readonly flush?: boolean | undefined;
};

export function Card({
  className,
  flush = false,
  ...props
}: CardProps): JSX.Element {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-3 rounded-card border bg-card py-4 text-card-foreground",
        flush && "gap-0 py-0",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-4",
        className,
      )}
      {...props}
    />
  );
}

export function CardTitle({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="card-title"
      className={cn("font-semibold text-body leading-5", className)}
      {...props}
    />
  );
}

export function CardDescription({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-body", className)}
      {...props}
    />
  );
}

export function CardAction({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({
  className,
  ...props
}: ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="card-content"
      className={cn("px-4", className)}
      {...props}
    />
  );
}

export type CardFooterProps = ComponentProps<"div"> & {
  /**
   * `form` is mockup v4's `.form-foot`: a sunken strip under a flush card,
   * a note on the left and the save button on the right.
   */
  readonly variant?: "default" | "form" | undefined;
};

export function CardFooter({
  className,
  variant = "default",
  ...props
}: CardFooterProps): JSX.Element {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center px-4 [.border-t]:pt-3",
        variant === "form" &&
          "justify-between gap-3 rounded-b-card border-t bg-surface-sunken py-3",
        className,
      )}
      {...props}
    />
  );
}

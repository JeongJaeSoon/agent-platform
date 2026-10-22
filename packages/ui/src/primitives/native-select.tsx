import type { ComponentProps, JSX } from "react";

import { cn } from "../lib/cn.ts";
import { useFieldControl } from "./field.tsx";

/*
 * shadcn/ui new-york NativeSelect: a styled <select>, chosen over the Radix
 * Select item. A native select submits with its form without a hidden mirror
 * input, and phones open their own picker, which screen readers and large
 * text already handle. Changed from upstream: Field wiring, an inline chevron
 * instead of lucide-react, card background, no `dark:` variants.
 */
export function NativeSelect({
  className,
  size = "default",
  ...props
}: Omit<ComponentProps<"select">, "size"> & {
  readonly size?: "sm" | "default" | undefined;
}): JSX.Element {
  return (
    <div
      className="group/native-select relative w-fit has-[select:disabled]:opacity-50"
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-card px-3 py-2 pr-9 text-sm shadow-xs outline-none transition-[color,box-shadow] disabled:pointer-events-none disabled:cursor-not-allowed data-[size=sm]:h-8 data-[size=sm]:py-1 motion-reduce:transition-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
          className,
        )}
        {...useFieldControl(props)}
      />
      <svg
        data-slot="native-select-icon"
        className="pointer-events-none absolute top-1/2 right-3.5 size-4 -translate-y-1/2 select-none text-muted-foreground"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

export function NativeSelectOption({
  className,
  ...props
}: ComponentProps<"option">): JSX.Element {
  return (
    <option
      data-slot="native-select-option"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

export function NativeSelectOptGroup({
  className,
  ...props
}: ComponentProps<"optgroup">): JSX.Element {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn("bg-[Canvas] text-[CanvasText]", className)}
      {...props}
    />
  );
}

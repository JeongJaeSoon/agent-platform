import type { ComponentProps, JSX } from "react";

import { cn } from "../foundations/cn.ts";

export type StatusDotStatus = "wait" | "run" | "idle" | "done" | "failed";

const STATUS_DOT: Record<StatusDotStatus, string> = {
  wait: "bg-(color:--ap-color-status-dot-wait)",
  // A turning ring; with reduced motion, a still dot like the others.
  run: "size-2.5 animate-spin border-[1.5px] border-(color:--ap-color-status-dot-run) border-r-transparent motion-reduce:size-2 motion-reduce:animate-none motion-reduce:border-r-(color:--ap-color-status-dot-run) motion-reduce:bg-(color:--ap-color-status-dot-run)",
  idle: "bg-(color:--ap-color-status-dot-idle)",
  done: "bg-(color:--ap-color-status-dot-done)",
  failed: "bg-(color:--ap-color-status-dot-failed)",
};

export type StatusDotProps = Omit<ComponentProps<"span">, "children"> & {
  readonly status: StatusDotStatus;
};

/**
 * Mockup v4's `.dot`: colour only, hidden from screen readers. The caller
 * puts the status's name beside it, as text or `sr-only`.
 */
export function StatusDot({
  status,
  className,
  style,
  ...props
}: StatusDotProps): JSX.Element {
  return (
    <span
      data-slot="status-dot"
      data-status={status}
      aria-hidden="true"
      className={cn(
        "size-2 flex-none rounded-full",
        STATUS_DOT[status],
        className,
      )}
      // Tailwind's spin turns once a second; v4 turns in 0.9s.
      style={status === "run" ? { animationDuration: "0.9s", ...style } : style}
      {...props}
    />
  );
}

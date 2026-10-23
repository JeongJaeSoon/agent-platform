import { cn, useReducedMotion } from "@werft-ai/ui";
import type { JSX } from "react";

import { AxisIcon } from "./axis-icon.tsx";
import {
  describeStatus,
  STATUS_AXIS_LABEL,
  type StatusAxis,
  type StatusStateOf,
  type StatusTone,
} from "./vocabulary.ts";

export interface StatusLabelProps<A extends StatusAxis> {
  readonly axis: A;
  readonly state: StatusStateOf<A>;
  /** Overrides the vocabulary copy; omit to use the §4.1 wording. */
  readonly label?: string | undefined;
  /** Overrides the axis name a screen reader hears first. */
  readonly axisLabel?: string | undefined;
  /** Secondary line: elapsed time, waiting reason, error code. */
  readonly detail?: string | undefined;
  /** The value may be out of date — say so instead of showing it as fresh. */
  readonly stale?: boolean | undefined;
  /** Override the stale mark and its hover text. */
  readonly staleLabel?: string | undefined;
  readonly staleHint?: string | undefined;
  /**
   * "dot" draws the session list's mark: a coloured dot, or a turning ring
   * while in flight, beside plain text, with `detail` after a middle dot.
   */
  readonly appearance?: "pill" | "dot" | undefined;
  readonly className?: string | undefined;
}

// ui-kit's status-dot tokens, falling back to the tone colours until they land.
const DOT_FILL: Record<StatusTone, string> = {
  attention: "bg-[var(--ap-color-status-dot-wait,var(--ap-tone-fg))]",
  caution: "bg-[var(--ap-color-status-dot-wait,var(--ap-tone-fg))]",
  progress: "bg-[var(--ap-color-status-dot-run,var(--ap-tone-fg))]",
  positive: "bg-[var(--ap-color-status-dot-done,var(--ap-tone-fg))]",
  danger: "bg-[var(--ap-color-status-dot-failed,var(--ap-tone-fg))]",
  neutral:
    "bg-[var(--ap-color-status-dot-idle,var(--ap-color-subtle-foreground))]",
  unknown:
    "bg-[var(--ap-color-status-dot-idle,var(--ap-color-subtle-foreground))]",
};

export function StatusLabel<A extends StatusAxis>({
  axis,
  state,
  label,
  axisLabel,
  detail,
  stale = false,
  staleLabel = "갱신 지연",
  staleHint = "마지막으로 확인한 값입니다",
  appearance = "pill",
  className,
}: StatusLabelProps<A>): JSX.Element {
  const descriptor = describeStatus(axis, state);
  const reducedMotion = useReducedMotion();
  const text = label ?? descriptor.label;

  if (appearance === "dot") {
    const spinning = descriptor.inFlight && !reducedMotion;
    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-2 whitespace-nowrap text-control text-foreground",
          className,
        )}
        data-axis={axis}
        data-state={state}
        data-tone={descriptor.tone}
        data-stale={stale || undefined}
      >
        <span
          aria-hidden="true"
          data-animated={spinning || undefined}
          className={cn(
            "flex-none rounded-full",
            spinning
              ? "size-2.5 animate-[ap-spin_0.9s_linear_infinite] border-[1.5px] border-[var(--ap-color-status-dot-run,var(--ap-tone-fg))] border-r-transparent"
              : cn("size-2", DOT_FILL[descriptor.tone]),
          )}
        />
        <span className="ap-visually-hidden">
          {axisLabel ?? STATUS_AXIS_LABEL[axis]}:{" "}
        </span>
        {/* A narrow column cuts the label, never the wait after it. */}
        <span className="flex min-w-0">
          <span className="min-w-0 truncate" title={text}>
            {text}
          </span>
          {detail ? (
            <span className="flex-none whitespace-pre"> · {detail}</span>
          ) : null}
        </span>
        {stale ? (
          <span
            className="text-caption text-muted-foreground"
            title={staleHint}
          >
            {staleLabel}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      className={cn("ap-status", className)}
      data-axis={axis}
      data-state={state}
      data-tone={descriptor.tone}
      data-stale={stale || undefined}
    >
      {/* One icon slot: a moving state's spinner takes the axis icon's place,
          so the axis reads from the label and the hidden axis name. */}
      {descriptor.inFlight && !reducedMotion ? (
        <span
          className="ap-status__spinner"
          data-animated="true"
          aria-hidden="true"
        />
      ) : (
        <AxisIcon axis={axis} />
      )}
      <span className="ap-visually-hidden">
        {axisLabel ?? STATUS_AXIS_LABEL[axis]}:{" "}
      </span>
      <span className="ap-status__text">{text}</span>
      {detail ? <span className="ap-status__detail">{detail}</span> : null}
      {stale ? (
        <span className="ap-status__stale" title={staleHint}>
          {staleLabel}
        </span>
      ) : null}
    </span>
  );
}

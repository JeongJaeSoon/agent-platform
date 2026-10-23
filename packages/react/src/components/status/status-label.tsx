import type { JSX } from "react";

import { cn } from "../foundations/cn.ts";
import { useReducedMotion } from "../foundations/use-reduced-motion.ts";
import { AxisIcon } from "./axis-icon.tsx";
import {
  describeStatus,
  STATUS_AXIS_LABEL,
  type StatusAxis,
  type StatusStateOf,
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
  readonly className?: string | undefined;
}

export function StatusLabel<A extends StatusAxis>({
  axis,
  state,
  label,
  axisLabel,
  detail,
  stale = false,
  staleLabel = "갱신 지연",
  staleHint = "마지막으로 확인한 값입니다",
  className,
}: StatusLabelProps<A>): JSX.Element {
  const descriptor = describeStatus(axis, state);
  const reducedMotion = useReducedMotion();
  const text = label ?? descriptor.label;

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

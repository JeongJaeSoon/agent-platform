import type { JSX } from "react";

import { cn } from "../lib/cn.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
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
  /** Secondary line: elapsed time, waiting reason, error code. */
  readonly detail?: string | undefined;
  /** The value may be out of date — say so instead of showing it as fresh. */
  readonly stale?: boolean | undefined;
  readonly className?: string | undefined;
}

export function StatusLabel<A extends StatusAxis>({
  axis,
  state,
  label,
  detail,
  stale = false,
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
      <AxisIcon axis={axis} />
      {descriptor.inFlight ? (
        <span
          className="ap-status__spinner"
          data-animated={reducedMotion ? undefined : "true"}
          aria-hidden="true"
        />
      ) : null}
      <span className="ap-visually-hidden">{STATUS_AXIS_LABEL[axis]}: </span>
      <span className="ap-status__text">{text}</span>
      {detail ? <span className="ap-status__detail">{detail}</span> : null}
      {stale ? (
        <span className="ap-status__stale" title="마지막으로 확인한 값입니다">
          갱신 지연
        </span>
      ) : null}
    </span>
  );
}

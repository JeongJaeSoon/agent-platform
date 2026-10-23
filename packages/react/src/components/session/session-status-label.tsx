import type { SessionStatus } from "@werft-ai/contracts";
import type { JSX } from "react";

import { StatusLabel } from "../status/status-label.tsx";

export interface SessionStatusLabelProps {
  readonly status: SessionStatus;
  /** The screen's word for the status, in its own locale. */
  readonly label: string;
  readonly axisLabel?: string | undefined;
  readonly className?: string | undefined;
}

export function SessionStatusLabel({
  status,
  label,
  axisLabel,
  className,
}: SessionStatusLabelProps): JSX.Element {
  return (
    <StatusLabel
      axis="session"
      state={status}
      label={label}
      axisLabel={axisLabel}
      className={className}
    />
  );
}

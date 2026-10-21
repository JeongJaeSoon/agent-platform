import type { SessionStatus, TurnStatus } from "@agent-platform/contracts";
import type { JSX } from "react";

import { StatusLabel } from "../status/status-label.tsx";

/*
 * A session's status is the state of its work, so it takes the turn axis's
 * tone and icon; the two states a turn does not have read as the turn that
 * left the session there.
 */
const TURN_OF_SESSION: Record<SessionStatus, TurnStatus> = {
  queued: "queued",
  running: "running",
  needs_input: "needs_input",
  idle: "completed",
  failed: "failed",
  stopped: "interrupted",
};

export interface SessionStatusLabelProps {
  readonly status: SessionStatus;
  /** The screen's word for the status; the turn vocabulary has no `idle`. */
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
      axis="turn"
      // A status this build does not know yet falls through as itself, and
      // the vocabulary draws it with the unknown tone.
      state={TURN_OF_SESSION[status] ?? (status as TurnStatus)}
      label={label}
      axisLabel={axisLabel}
      className={className}
    />
  );
}

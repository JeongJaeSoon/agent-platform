import type { StructuredLogger } from "@agent-platform/observability";

export type ControlResultEvent = {
  acceptedAt: Date;
  controlId: string;
  effectiveAt: Date;
  operation: "interrupt" | "terminate";
  outcome: string;
  reasonCode: string;
  sessionId: string;
};

export function logControlResult(
  logger: Pick<StructuredLogger, "info"> | undefined,
  result: ControlResultEvent,
): void {
  const effectMs = Math.max(
    0,
    result.effectiveAt.getTime() - result.acceptedAt.getTime(),
  );
  logger?.info("Control result recorded", {
    event: "control.result",
    operation: result.operation,
    outcome: result.outcome,
    reason_code: result.reasonCode,
    duration_ms: effectMs,
    effect_ms: effectMs,
    control_id: result.controlId,
    session_id: result.sessionId,
  });
}

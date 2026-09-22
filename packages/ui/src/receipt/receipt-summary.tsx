import type {
  Receipt,
  ReceiptOperation,
  ReceiptStatus,
  ReceiptTarget,
} from "@agent-platform/contracts";
import type { JSX, ReactNode } from "react";

import { guidanceFor } from "../feedback/error-guidance.ts";
import { cn } from "../lib/cn.ts";
import { StatusLabel } from "../status/status-label.tsx";
import { formatTimestamp } from "./format-timestamp.ts";

export const RECEIPT_OPERATION_LABEL: Record<ReceiptOperation, string> = {
  create_session: "세션 시작",
  append_message: "메시지 전송",
  answer: "답변 제출",
  interrupt: "중단 요청",
  pause: "일시정지 요청",
  terminate: "종료 요청",
  resume: "재개 요청",
  recovery_decision: "복구 결정",
};

export type ReceiptTimestamps = Pick<Receipt, "created_at" | "updated_at">;
export type ReceiptError = Receipt["error"];

export interface ReceiptSummaryProps {
  readonly operation: ReceiptOperation;
  readonly status: ReceiptStatus;
  readonly target: ReceiptTarget;
  readonly timestamps: ReceiptTimestamps;
  readonly error?: ReceiptError | undefined;
  /** Trailing slot: `ReceiptLink`, a retry button, whatever the screen owns. */
  readonly action?: ReactNode | undefined;
  readonly className?: string | undefined;
}

/**
 * Draws the receipt the server returned. It never infers a status: 접수(accepted)
 * is not completion, and `unknown` stays `unknown` (§1, §4.1).
 */
export function ReceiptSummary({
  operation,
  status,
  target,
  timestamps,
  error,
  action,
  className,
}: ReceiptSummaryProps): JSX.Element {
  const guidance = guidanceFor(error?.code);

  return (
    <div className={cn("ap-receipt", className)} data-status={status}>
      <div className="ap-receipt__head">
        <span className="ap-receipt__operation">
          {Object.hasOwn(RECEIPT_OPERATION_LABEL, operation)
            ? RECEIPT_OPERATION_LABEL[operation]
            : operation}
        </span>
        <StatusLabel axis="receipt" state={status} />
      </div>

      <dl className="ap-receipt__target">
        {"session_id" in target ? (
          <>
            <div className="ap-receipt__field">
              <dt>세션</dt>
              <dd className="ap-receipt__id">{target.session_id}</dd>
            </div>
            {target.turn_id ? (
              <div className="ap-receipt__field">
                <dt>턴</dt>
                <dd className="ap-receipt__id">{target.turn_id}</dd>
              </div>
            ) : null}
            {target.request_id ? (
              <div className="ap-receipt__field">
                <dt>요청</dt>
                <dd className="ap-receipt__id">{target.request_id}</dd>
              </div>
            ) : null}
          </>
        ) : (
          // A mutation outside a session names its resource instead (94S-148).
          // The kind shows raw until a screen actually renders one of these —
          // the ticket that adds that route owns the Korean label for it.
          <div className="ap-receipt__field">
            <dt>대상</dt>
            <dd className="ap-receipt__id">
              {target.resource.kind} · {target.resource.id}
            </dd>
          </div>
        )}
      </dl>

      {error ? (
        <p className="ap-receipt__error">
          <span className="ap-receipt__guidance">{guidance}</span>
          <span className="ap-receipt__detail">
            {error.code} · {error.message}
          </span>
        </p>
      ) : null}

      <div className="ap-receipt__foot">
        <span className="ap-receipt__times">
          접수{" "}
          <time dateTime={timestamps.created_at}>
            {formatTimestamp(timestamps.created_at)}
          </time>
          {timestamps.updated_at !== timestamps.created_at ? (
            <>
              {" · 갱신 "}
              <time dateTime={timestamps.updated_at}>
                {formatTimestamp(timestamps.updated_at)}
              </time>
            </>
          ) : null}
        </span>
        {action}
      </div>
    </div>
  );
}

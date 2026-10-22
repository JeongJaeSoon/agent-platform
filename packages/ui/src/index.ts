/*
 * packages/ui draws what the server said and nothing else: no fetch, no
 * permission judgement, no state-transition policy (Kollegium v1 §12.4). If a
 * component here needs to know whether something is allowed, the prop is wrong.
 *
 * The layers (foundations, primitives, patterns) export through their own
 * index. The modules named one by one take @werft-ai/contracts types and have
 * no layer here because they are leaving this package for packages/react.
 */

export { ERROR_GUIDANCE, guidanceFor } from "./feedback/error-guidance.ts";
export { ErrorState, type ErrorStateProps } from "./feedback/error-state.tsx";
export * from "./foundations/index.ts";
export * from "./patterns/index.ts";
export * from "./primitives/index.ts";
export { ReceiptLink, type ReceiptLinkProps } from "./receipt/receipt-link.tsx";
export {
  RECEIPT_OPERATION_LABEL,
  type ReceiptError,
  ReceiptSummary,
  type ReceiptSummaryProps,
  type ReceiptTimestamps,
} from "./receipt/receipt-summary.tsx";
export {
  ApprovalCard,
  type ApprovalCardMessages,
  type ApprovalCardProps,
  type PermissionRequest,
} from "./session/approval-card.tsx";
export {
  Composer,
  type ComposerMessages,
  type ComposerProps,
  type ComposerQueuedMessage,
} from "./session/composer.tsx";
export { Message, type MessageProps } from "./session/message.tsx";
export {
  type QuestionAnswer,
  QuestionCard,
  type QuestionCardMessages,
  type QuestionCardProps,
  type QuestionRequest,
} from "./session/question-card.tsx";
export {
  SessionRow,
  type SessionRowLink,
  type SessionRowMessages,
  type SessionRowProps,
} from "./session/session-row.tsx";
export {
  SessionStatusLabel,
  type SessionStatusLabelProps,
} from "./session/session-status-label.tsx";
export {
  SessionTable,
  type SessionTableProps,
} from "./session/session-table.tsx";
export {
  StageIndicator,
  type StageIndicatorProps,
} from "./session/stage-indicator.tsx";
export {
  Timeline,
  type TimelineEntry,
  type TimelineKind,
  type TimelineMessages,
  type TimelineProps,
  timelineKind,
} from "./session/timeline.tsx";
export {
  type FormatTurnMessage,
  turnSummaryText,
} from "./session/turn-text.ts";
export { StatusLabel, type StatusLabelProps } from "./status/status-label.tsx";
export {
  describeStatus,
  STATUS_AXIS_LABEL,
  STATUS_AXIS_VALUES,
  STATUS_TONE_VALUES,
  STATUS_VOCABULARY,
  type StatusAxis,
  type StatusDescriptor,
  type StatusStateOf,
  type StatusTone,
} from "./status/vocabulary.ts";

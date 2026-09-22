/*
 * packages/ui draws what the server said and nothing else: no fetch, no
 * permission judgement, no state-transition policy (Kollegium §12.4). If a
 * component here needs to know whether something is allowed, the prop is wrong.
 */

export {
  ConfirmDialog,
  type ConfirmDialogProps,
} from "./dialog/confirm-dialog.tsx";
export {
  DestructiveActionDialog,
  type DestructiveActionDialogProps,
} from "./dialog/destructive-action-dialog.tsx";
export { EmptyState, type EmptyStateProps } from "./feedback/empty-state.tsx";
export { ERROR_GUIDANCE, guidanceFor } from "./feedback/error-guidance.ts";
export { ErrorState, type ErrorStateProps } from "./feedback/error-state.tsx";
export { Skeleton, type SkeletonProps } from "./feedback/skeleton.tsx";
export { cn } from "./lib/cn.ts";
export { useReducedMotion } from "./lib/use-reduced-motion.ts";
export { formatTimestamp } from "./receipt/format-timestamp.ts";
export { ReceiptLink, type ReceiptLinkProps } from "./receipt/receipt-link.tsx";
export {
  RECEIPT_OPERATION_LABEL,
  type ReceiptError,
  ReceiptSummary,
  type ReceiptSummaryProps,
  type ReceiptTimestamps,
} from "./receipt/receipt-summary.tsx";
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

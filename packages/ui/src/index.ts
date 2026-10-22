/*
 * packages/ui draws what the server said and nothing else: no fetch, no
 * permission judgement, no state-transition policy (Kollegium v1 §12.4). If a
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
export {
  Badge,
  type BadgeProps,
  badgeVariants,
} from "./primitives/badge.tsx";
export {
  Button,
  type ButtonProps,
  buttonVariants,
} from "./primitives/button.tsx";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./primitives/card.tsx";
export { Checkbox } from "./primitives/checkbox.tsx";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./primitives/dialog.tsx";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  type FieldProps,
  FieldSet,
  fieldVariants,
} from "./primitives/field.tsx";
export { Input } from "./primitives/input.tsx";
export {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "./primitives/native-select.tsx";
export { RadioGroup, RadioGroupItem } from "./primitives/radio-group.tsx";
export {
  Stepper,
  type StepperProps,
  type StepperStep,
} from "./primitives/stepper.tsx";
export {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  tabsListVariants,
} from "./primitives/tabs.tsx";
export { Textarea } from "./primitives/textarea.tsx";
export { formatTimestamp } from "./receipt/format-timestamp.ts";
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
  type TimelineMessages,
  type TimelineProps,
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

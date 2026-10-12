import { z } from "zod";

import { receiptActorSchema } from "../musterrolle/authorization.ts";
import {
  receiptIdSchema,
  revisionSchema,
  sessionIdParamsSchema,
  sessionIdSchema,
  timestampSchema,
} from "../shared/index.ts";

// requested → approved | rejected is a human decision; approved → pushing →
// pushed | failed is the platform's push. Nothing returns to `requested`.
export const PUSH_REQUEST_STATE_VALUES = [
  "requested",
  "approved",
  "rejected",
  "pushing",
  "pushed",
  "failed",
] as const;
export const pushRequestStateSchema = z.enum(PUSH_REQUEST_STATE_VALUES);

/** States that keep a session from opening another request. */
export const OPEN_PUSH_REQUEST_STATES = [
  "requested",
  "approved",
  "pushing",
] as const satisfies readonly PushRequestState[];

export const PUSH_BRANCH_PREFIX = "agent/";

/** The only branch a session's result is ever pushed to. */
export function pushBranchFor(sessionId: string): string {
  return `${PUSH_BRANCH_PREFIX}${sessionId.toLowerCase()}`;
}

export const pushRequestIdSchema = z.uuid();
export const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const pushRequestParamsSchema = sessionIdParamsSchema.extend({
  push_request_id: pushRequestIdSchema,
});

export const pushRequestSchema = z.object({
  id: pushRequestIdSchema,
  session_id: sessionIdSchema,
  repository_id: z.string().min(1),
  checkpoint_revision: revisionSchema,
  git_commit: gitCommitShaSchema,
  target_branch: z.string().min(1),
  state: pushRequestStateSchema,
  requested_by: receiptActorSchema,
  requested_at: timestampSchema,
  decided_by: receiptActorSchema.nullable(),
  decided_at: timestampSchema.nullable(),
  decision_reason: z.string().nullable(),
  request_receipt_id: receiptIdSchema,
  decision_receipt_id: receiptIdSchema.nullable(),
  // Set once the platform's push ended, pushed or failed; its receipt says
  // where the commit went or why it did not.
  finished_at: timestampSchema.nullable(),
  push_receipt_id: receiptIdSchema.nullable(),
});

export const createPushRequestRequestSchema = z.object({}).strict();

export const PUSH_DECISION_VALUES = ["approve", "reject"] as const;
export const pushDecisionSchema = z.enum(PUSH_DECISION_VALUES);
export const decidePushRequestRequestSchema = z
  .object({
    decision: pushDecisionSchema,
    // The commit the decider reviewed; an approval of any other is refused.
    git_commit: gitCommitShaSchema,
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const listPushRequestsResponseSchema = z.object({
  items: z.array(pushRequestSchema),
});

// Why a push operation was refused, as its receipt and error details say.
export const PUSH_REFUSAL_VALUES = [
  "missing_scope",
  "unverified_principal",
  "not_found",
  "no_repository",
  "no_checkpoint",
  "checkpoint_unavailable",
  "request_open",
  "already_decided",
  "checkpoint_moved",
  "commit_mismatch",
  // The platform's push of an approved request.
  "catalog_changed",
  "target_refused",
  "default_branch",
  "non_fast_forward",
  "no_push_credential",
  "lease_expired",
  "push_failed",
] as const;
export const pushRefusalSchema = z.enum(PUSH_REFUSAL_VALUES);

/**
 * `result` of a `request_push`, `decide_push` or `push` receipt. Fields the
 * refused attempt never learned (a scope refusal reads no row) are null.
 */
export const pushReceiptResultSchema = z.object({
  push_request_id: pushRequestIdSchema.nullable(),
  decision: pushDecisionSchema.nullable(),
  verdict: z.enum(["allow", "refuse"]),
  refusal: pushRefusalSchema.nullable(),
  repository_id: z.string().nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  git_commit: gitCommitShaSchema.nullable(),
  target_branch: z.string().nullable(),
  // A `push` receipt only: where the commit went, what the ref held before,
  // and who approved it.
  remote_url: z.string().nullable().optional(),
  remote_ref: z.string().nullable().optional(),
  previous_commit: gitCommitShaSchema.nullable().optional(),
  approved_by: receiptActorSchema.nullable().optional(),
});

export type PushRequestState = (typeof PUSH_REQUEST_STATE_VALUES)[number];
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PushDecision = z.infer<typeof pushDecisionSchema>;
export type DecidePushRequestRequest = z.infer<
  typeof decidePushRequestRequestSchema
>;
export type ListPushRequestsResponse = z.infer<
  typeof listPushRequestsResponseSchema
>;
export type PushRefusal = z.infer<typeof pushRefusalSchema>;
export type PushReceiptResult = z.infer<typeof pushReceiptResultSchema>;

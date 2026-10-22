import { z } from "zod";

import {
  receiptActorSchema,
  resourceRefSchema,
} from "../musterrolle/authorization.ts";
import {
  apiErrorCodeSchema,
  receiptIdSchema,
  requestIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const RECEIPT_STATUS_VALUES = [
  "accepted",
  "succeeded",
  "failed",
  "unknown",
] as const;
export const RECEIPT_OPERATION_VALUES = [
  "create_session",
  "append_message",
  "answer",
  "interrupt",
  "pause",
  // The owner's ordinary close, distinct from terminate and from an
  // operator's recovery close (recovery_decision).
  "close",
  "terminate",
  "resume",
  "recovery_decision",
  // A session moved onto another catalog profile from its next turn on.
  "change_profile",
  // The operator's execution revocation; written on the session
  // owner's receipt list so the owner sees why the session stopped.
  "revoke_execution",
  // Account recovery (94S-264): a one-time link issued and the password set
  // from it, and an owner added or restored by BOOTSTRAP_TOKEN when no live
  // owner remained.
  "issue_password_reset",
  "reset_password",
  "recover_owner",
  // An owner taking over a session whose requester was offboarded.
  "takeover",
  // A person linking or unlinking their own Slack account.
  "link_account",
  "unlink_account",
  // Invites and roles (94S-153).
  "invite_member",
  "accept_invite",
  "revoke_invite",
  "change_member_role",
  // Turning a membership or a whole account off and back on (94S-464).
  "disable_member",
  "enable_member",
  "disable_user",
  "enable_user",
  "create_agent",
  "update_agent",
  "create_agent_release",
  "activate_agent",
  // Issuing and revoking an API key from the web or the API (94S-574).
  "create_api_key",
  "revoke_api_key",
  // Teams and who administers an agent (94S-582). Adding a member writes its
  // receipt on that member, so it is also their notice of the change.
  "create_team",
  "rename_team",
  "delete_team",
  "add_team_member",
  "remove_team_member",
  "add_agent_admin",
  "remove_agent_admin",
  // Binding a credential name to an agent and taking it off (94S-581).
  "bind_credential",
  "unbind_credential",
  // Pinning an agent to its Slack app and bot, and taking that back (M8).
  "link_agent_identity",
  "revoke_agent_identity",
  // Changing who sees a session (94S-584).
  "share_session",
  // A push request, a human's decision on one (or a refused attempt at
  // either), and the platform's push of an approved one.
  "request_push",
  "decide_push",
  "push",
  "open_pull_request",
  "comment_pull_request",
  // A remote MCP exchange the egress proxy refused for the agent's
  // credential: unbound, not for this workspace, or moved in the catalog.
  "call_mcp",
] as const;

export const receiptStatusSchema = z.enum(RECEIPT_STATUS_VALUES);
export const receiptOperationSchema = z.enum(RECEIPT_OPERATION_VALUES);
// The alpha shape, unchanged: every session operation still answers with
// exactly these three fields.
// Strict on both sides, so a target can only ever be one of the two: a value
// carrying both shapes would otherwise match the session branch and have its
// resource fields silently stripped. It also matches what the generated
// OpenAPI already promised (`additionalProperties: false`).
export const receiptSessionTargetSchema = z
  .object({
    session_id: sessionIdSchema,
    turn_id: turnIdSchema.nullable(),
    request_id: requestIdSchema.nullable(),
  })
  .strict();
// Mutations outside a session — invites, agents, releases, dispatches, memory,
// routines — name their resource instead. Each route adds its own
// `operation` value in its own ticket; the vocabulary here stays session-only
// until one does.
export const receiptResourceTargetSchema = z
  .object({
    resource: resourceRefSchema,
    workspace_id: workspaceIdSchema.nullable(),
  })
  .strict();
// A user is not a grantable resource, so it has its own variant instead of a
// resource kind.
export const receiptUserTargetSchema = z
  .object({
    user_id: userIdSchema,
    workspace_id: workspaceIdSchema,
  })
  .strict();
export const receiptTargetSchema = z.union([
  receiptSessionTargetSchema,
  receiptResourceTargetSchema,
  receiptUserTargetSchema,
]);
export const receiptErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
});
export const receiptSchema = z.object({
  id: receiptIdSchema,
  operation: receiptOperationSchema,
  target_ref: receiptTargetSchema,
  // Who asked for this. Legacy alpha rows have no actor to report.
  actor: receiptActorSchema.optional(),
  status: receiptStatusSchema,
  // Input receipts keep the acceptance response for good, because a retry
  // with the same Idempotency-Key replays exactly that body (api.md, common
  // rules). Every writer that settles one — finalize, execution gone,
  // terminate, recovery decisions — changes `status` and `error` only.
  result: z.unknown().nullable().meta({
    description:
      "For create_session and append_message: the acceptance response exactly as first returned, never rewritten; its receipt_status and status are acceptance-time values. The current outcome is this receipt's status and error; the turn's result is read from GET /v1/sessions/{session_id}/turns/{turn_id} using target_ref. For interrupt: `{turn_id, terminal, no_op}` once settled, where `no_op: true` means the turn reached `terminal` on its own and the interrupt did nothing.",
  }),
  error: receiptErrorSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const getReceiptResponseSchema = receiptSchema;

export const receiptAcceptedResponseSchema = z.object({
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
});

export const terminateReceiptResultSchema = z.object({
  execution_gone: z.boolean(),
  checkpoint_revision: revisionSchema.nullable(),
  unconfirmed_turn_id: turnIdSchema.nullable(),
  // A kill removes the execution; whatever it already did outside (commits,
  // pushes, API calls) stays done. The receipt says so instead of letting
  // "succeeded" read as a rollback.
  external_effects_reverted: z.literal(false),
});

export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;
export type ReceiptOperation = z.infer<typeof receiptOperationSchema>;
export type ReceiptSessionTarget = z.infer<typeof receiptSessionTargetSchema>;
export type ReceiptResourceTarget = z.infer<typeof receiptResourceTargetSchema>;
export type ReceiptUserTarget = z.infer<typeof receiptUserTargetSchema>;
export type ReceiptTarget = z.infer<typeof receiptTargetSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type GetReceiptResponse = z.infer<typeof getReceiptResponseSchema>;
export type ReceiptAcceptedResponse = z.infer<
  typeof receiptAcceptedResponseSchema
>;
export type TerminateReceiptResult = z.infer<
  typeof terminateReceiptResultSchema
>;

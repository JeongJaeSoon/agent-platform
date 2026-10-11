import { z } from "zod";

export const API_ERROR_CODE_VALUES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BOOTSTRAP_DONE",
  "NOT_FOUND",
  "PAYLOAD_TOO_LARGE",
  "REQUEST_TIMEOUT",
  "UNSUPPORTED_CAPABILITY",
  "RATE_LIMITED",
  // The installation's retained-content budget is spent; retrying does not
  // free any of it.
  "STORAGE_LIMIT_EXCEEDED",
  // A turn the engine ended because the session's cost budget ran out while
  // it was running.
  "BUDGET_EXCEEDED",
  "INTERNAL_ERROR",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_EXPIRED",
  "REQUEST_STALE",
  "SESSION_PAUSED",
  "SESSION_RESUMING",
  "SESSION_CLOSED",
  "SESSION_STOPPED",
  "RECOVERY_REQUIRED",
  "CHECKPOINT_UNAVAILABLE",
  "PAUSE_COMMITTING",
  "PAUSE_CANCELLED",
  "CONTROL_SUPERSEDED",
  "TURN_NOT_STARTED",
  "BACKEND_UNAVAILABLE",
  "LAUNCH_FAILED",
  // The catalog no longer allows the session's (profile, repository) pair,
  // so no worker may run it until an operator restores the pair.
  "CATALOG_MISMATCH",
  // The person who asked for the session was offboarded; it takes no input
  // until an owner takes it over.
  "TAKEOVER_REQUIRED",
  // Linking a Slack account (94S-577): the workspace has no verified Slack
  // install, the account is from another Slack team, it is linked to someone
  // else, or the caller already linked a different account in that team.
  "SLACK_NOT_INSTALLED",
  "LINK_TEAM_MISMATCH",
  "LINK_TAKEN",
  "LINK_EXISTS",
  // An invite that was revoked, replaced by a newer one, or has expired.
  "INVITE_EXPIRED",
  "INVITE_USED",
  // The change would leave the workspace with no live owner.
  "LAST_OWNER",
  // An admin granting the owner role or changing an owner's (design 4.1).
  "OWNER_PROTECTED",
  // A key asked for more than its issuer holds now, or an agent's key asked
  // to approve (design 4.1, D26).
  "SCOPE_NOT_GRANTABLE",
  // A session named a release made for another runtime profile.
  "RELEASE_PROFILE_MISMATCH",
  // An external login whose verified address already has an account: it is
  // never joined by email, the owner links it after signing in (design 3.1).
  "LOGIN_LINK_REQUIRED",
  // A release was made against a runtime profile whose settings have changed
  // since; it has to be released again before it can run.
  "PROFILE_DIGEST_MISMATCH",
  "ALREADY_EXISTS",
  "NOT_READY",
  "CURSOR_EXPIRED",
  "LEASE_EXPIRED",
  "STALE_EPOCH",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODE_VALUES);
export const apiErrorSchema = z
  .object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    request_id: z.string().min(1),
    details: z.unknown().nullable(),
  })
  .strict();
export const apiErrorResponseSchema = z
  .object({ error: apiErrorSchema })
  .strict();

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

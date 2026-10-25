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
  // Still draining towards closed, and could yet fall back to active.
  "SESSION_CLOSING",
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
  // The Slack app is already pinned to another agent (M8).
  "AGENT_IDENTITY_TAKEN",
  // Slack apps: the workspace's App Configuration Token is unset
  // or Slack no longer takes it; an app for the agent is being created, or
  // its creation's answer was lost; the agent has no active release yet.
  "CONFIG_TOKEN_INVALID",
  "SLACK_APP_CREATING",
  "AGENT_NOT_ACTIVE",
  // Installing an agent's Slack app: the install link's state is unknown,
  // spent, expired or another's; Slack sent the admin back with an error;
  // Slack's answer is not the expected app, team or scopes; the app is
  // already installed in that team for another workspace.
  "SLACK_INSTALL_STATE_INVALID",
  "SLACK_INSTALL_DENIED",
  "SLACK_INSTALL_REJECTED",
  "SLACK_INSTALL_CONFLICT",
  // Linking a Slack account: the workspace has no link app, no usable
  // config token to make one with, and no hand-made OIDC app to fall back on.
  "SLACK_LINK_NOT_CONFIGURED",
  // An invite that was revoked, replaced by a newer one, or has expired.
  "INVITE_EXPIRED",
  "INVITE_USED",
  // The change would leave the workspace with no live owner.
  "LAST_OWNER",
  // An admin granting the owner role or changing an owner's (design 4.1).
  "OWNER_PROTECTED",
  // A manager changing their own role or access.
  "SELF_PROTECTED",
  // A role change for a member whose membership is disabled.
  "MEMBER_DISABLED",
  // A role change or membership enable for a suspended account: only lifting
  // the suspension brings the person back.
  "ACCOUNT_DISABLED",
  // A key asked for more than its issuer holds now, or an agent's key asked
  // to approve (design 4.1, D26).
  "SCOPE_NOT_GRANTABLE",
  // A session named a release made for another runtime profile.
  "RELEASE_PROFILE_MISMATCH",
  // A release names a credential its agent has no live binding for: at
  // activation, and again when a session starts (design 4.4, D11).
  "CREDENTIAL_UNBOUND",
  // An agent identity holds the credential name, or the name is bound to an
  // agent an identity would take it from.
  "CREDENTIAL_REF_IN_USE",
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
  // Push requests: the session has no repository or checkpoint to push,
  // another request is still open, the request was already decided, or the
  // session checkpointed again after the request pinned its commit.
  "PUSH_SOURCE_MISSING",
  "PUSH_REQUEST_OPEN",
  "PUSH_REQUEST_DECIDED",
  "CHECKPOINT_MOVED",
  // Pull requests: the push request has not reached `pushed`, or no pull
  // request was opened from it yet.
  "PUSH_NOT_PUSHED",
  "PULL_REQUEST_MISSING",
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

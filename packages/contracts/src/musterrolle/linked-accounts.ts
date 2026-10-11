import { z } from "zod";

// A person's account on another service, tied to their user (design A.2,
// D2). v1 links Slack only, through Sign in with Slack; no token is kept.

export const LINKED_ACCOUNT_PROVIDER_VALUES = ["slack"] as const;
export const linkedAccountProviderSchema = z.enum(
  LINKED_ACCOUNT_PROVIDER_VALUES,
);

/**
 * `stale`: the provider reported the account deactivated; it resolves to no
 * one until the person links again. `revoked`: unlinked from the web or
 * revoked by offboarding; a revoked row never comes back.
 */
export const LINKED_ACCOUNT_STATUS_VALUES = [
  "active",
  "stale",
  "revoked",
] as const;
export const linkedAccountStatusSchema = z.enum(LINKED_ACCOUNT_STATUS_VALUES);

export const LINKED_ACCOUNT_REVOKED_REASON_VALUES = [
  "unlinked",
  "offboarded",
] as const;
export const linkedAccountRevokedReasonSchema = z.enum(
  LINKED_ACCOUNT_REVOKED_REASON_VALUES,
);

export type LinkedAccountProvider = z.infer<typeof linkedAccountProviderSchema>;
export type LinkedAccountStatus = z.infer<typeof linkedAccountStatusSchema>;
export type LinkedAccountRevokedReason = z.infer<
  typeof linkedAccountRevokedReasonSchema
>;

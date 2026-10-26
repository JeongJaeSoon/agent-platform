import { z } from "zod";

import { receiptAcceptedResponseSchema } from "../api/receipt.ts";
import {
  receiptIdSchema,
  revisionSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

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

export const linkedAccountIdSchema = z.uuid();

export const linkedAccountSchema = z
  .object({
    id: linkedAccountIdSchema,
    user_id: userIdSchema,
    provider: linkedAccountProviderSchema,
    /** The Slack team id the account belongs to. */
    external_tenant: z.string().min(1).max(255),
    /** The Slack user id. */
    external_user_id: z.string().min(1).max(255),
    /**
     * The workspace name Slack gave when the account was last verified;
     * null for links made before names were kept, or when Slack sent none.
     */
    external_tenant_name: z.string().min(1).max(255).nullable(),
    /** The person's Slack display name, on the same terms. */
    external_user_name: z.string().min(1).max(255).nullable(),
    status: linkedAccountStatusSchema,
    verified_at: timestampSchema,
    revision: revisionSchema,
    expires_at: timestampSchema.nullable().meta({
      description:
        "When the provider token kept for this account expires. Null when no token is kept or it does not expire; Slack links keep no token, so a Slack account is always null. Not the `expires_at` of the link start response, which is when that link request lapses.",
    }),
  })
  .strict();

export const LINKED_ACCOUNT_LIST_LIMIT = 50;

export const listLinkedAccountsResponseSchema = z
  .object({
    items: z.array(linkedAccountSchema).max(LINKED_ACCOUNT_LIST_LIMIT),
  })
  .strict();

export const linkedAccountParamsSchema = z
  .object({ id: linkedAccountIdSchema })
  .strict();

export const startSlackLinkResponseSchema = z
  .object({
    /** Where the browser goes next: Slack's consent screen. */
    authorize_url: z.url(),
    expires_at: timestampSchema.meta({
      description:
        "When this link request lapses: the callback must come before it. Not a linked account's `expires_at`, which is its provider token's expiry.",
    }),
  })
  .strict();

export const slackLinkCallbackRequestSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(512),
  })
  .strict();

export const slackLinkCallbackResponseSchema = z
  .object({
    linked_account: linkedAccountSchema,
    receipt_id: receiptIdSchema,
  })
  .strict();

export const unlinkAccountResponseSchema = receiptAcceptedResponseSchema;

// What the person sees when a link is refused. They are product copy, shown
// as the API's error message so the web screen shows the same words.
export const LINK_MESSAGES = {
  signInRequired:
    "웹에 로그인한 뒤 다시 열어 주세요. 계정이 없으면 owner·admin에게 초대를 요청하세요",
  notInstalled:
    "이 워크스페이스에는 아직 Slack이 설치되지 않았어요. owner·admin에게 문의하세요",
  teamMismatch: (workspaceName: string) =>
    `이 Slack 워크스페이스는 연결된 곳이 아니에요. ${workspaceName} 워크스페이스 계정으로 다시 시도하세요`,
  taken:
    "이 Slack 계정은 다른 사용자에게 연결돼 있어요. owner·admin에게 문의하세요",
  exists: "이미 연결된 Slack 계정이 있어요. 해제한 뒤 다시 연결하세요",
  expired: "연결 요청이 만료됐어요. 처음부터 다시 시도하세요",
} as const;

export type LinkedAccountProvider = z.infer<typeof linkedAccountProviderSchema>;
export type LinkedAccountStatus = z.infer<typeof linkedAccountStatusSchema>;
export type LinkedAccountRevokedReason = z.infer<
  typeof linkedAccountRevokedReasonSchema
>;
export type LinkedAccount = z.infer<typeof linkedAccountSchema>;
export type ListLinkedAccountsResponse = z.infer<
  typeof listLinkedAccountsResponseSchema
>;
export type StartSlackLinkResponse = z.infer<
  typeof startSlackLinkResponseSchema
>;
export type SlackLinkCallbackRequest = z.infer<
  typeof slackLinkCallbackRequestSchema
>;
export type SlackLinkCallbackResponse = z.infer<
  typeof slackLinkCallbackResponseSchema
>;
export type UnlinkAccountResponse = z.infer<typeof unlinkAccountResponseSchema>;

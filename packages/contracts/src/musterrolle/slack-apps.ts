import { z } from "zod";

import { agentIdSchema, timestampSchema } from "../shared/index.ts";
import { slackIdSchema } from "./agent-identities.ts";
import {
  type SECRET_PURPOSE_VALUES,
  slackSecretSummarySchema,
} from "./slack-secrets.ts";
import { workspaceParamsSchema } from "./workspaces.ts";

/**
 * The bot scopes every agent app is created with and the authorize URL asks
 * for. Adding one grants the agent more authority in Slack, which is why a
 * test pins the list. `channels:join` lets the agent join a public channel
 * the console picks for it; `groups:write` lets it leave a private channel
 * whose invite an admin turned down.
 */
export const BOT_SCOPES = [
  "assistant:write",
  "app_mentions:read",
  "chat:write",
  "im:history",
  "channels:history",
  "groups:history",
  "channels:read",
  "groups:read",
  "users:read",
  "channels:join",
  "groups:write",
] as const;

/**
 * The bot events Finalize registers once the events route can answer the
 * app's signed challenge; creation registers none. `member_joined_channel`
 * is how an invite to a private channel is noticed.
 */
export const SLACK_AGENT_BOT_EVENTS = [
  "app_mention",
  "message.im",
  "message.channels",
  "message.groups",
  "member_joined_channel",
  "app_uninstalled",
  "tokens_revoked",
] as const;

/**
 * `agent`: one app per agent, created by the platform. `link`: the
 * workspace's account-linking app, also platform-made. `manual`: an app a
 * person made, whose secrets a person enters.
 */
export const SLACK_APP_KIND_VALUES = ["agent", "link", "manual"] as const;

/**
 * `creating` is written before Slack is asked, so a lost answer leaves a
 * trace instead of a second app. `failed`: Slack refused, no app exists.
 * `abandoned`: a `creating` row a person chose to give up on; Slack may
 * still hold that app.
 */
export const SLACK_APP_STATE_VALUES = [
  "creating",
  "created",
  "failed",
  "abandoned",
  "deleting",
  "deleted",
] as const;

/** Every purpose but the workspace's config token. */
export const SLACK_APP_SECRET_PURPOSE_VALUES = [
  "slack_signing_secret",
  "slack_client_secret",
  "slack_bot_token",
] as const satisfies readonly (typeof SECRET_PURPOSE_VALUES)[number][];

export const slackAppKindSchema = z.enum(SLACK_APP_KIND_VALUES);
export const slackAppStateSchema = z.enum(SLACK_APP_STATE_VALUES);
export const slackAppSecretPurposeSchema = z.enum(
  SLACK_APP_SECRET_PURPOSE_VALUES,
);
export const slackAppIdSchema = z.uuid();

export const slackAppSchema = z
  .object({
    id: slackAppIdSchema,
    kind: slackAppKindSchema,
    agent_id: agentIdSchema.nullable(),
    state: slackAppStateSchema,
    /** Slack's app id; null until Slack has answered the create call. */
    app_id: slackIdSchema.nullable(),
    client_id: z.string().min(1).max(64).nullable(),
    redirect_url: z.url(),
    /** The Slack user whose config token created the app (its collaborator). */
    created_by_token_user: slackIdSchema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    /** Whether each secret is stored; never the values. */
    secrets: z
      .object({
        slack_signing_secret: slackSecretSummarySchema,
        slack_client_secret: slackSecretSummarySchema,
        slack_bot_token: slackSecretSummarySchema,
      })
      .strict(),
  })
  .strict();

/**
 * Something the caller should know that did not stop the request: the
 * config token now belongs to another Slack user, who becomes each new
 * app's collaborator.
 */
export const slackWarningSchema = z
  .object({
    code: z.literal("config_token_issuer_changed"),
    previous_user_id: slackIdSchema,
    user_id: slackIdSchema,
  })
  .strict();

export const createSlackAppRequestSchema = z
  .object({
    /**
     * Give up on an earlier creation whose answer was lost (409
     * SLACK_APP_CREATING with `uncertain: true`) after checking Slack holds
     * no such app, and create a new one.
     */
    replace_uncertain: z.boolean().default(false),
  })
  .strict();

export const createSlackAppResponseSchema = z
  .object({
    slack_app: slackAppSchema,
    /** False when the agent already had this app. */
    created: z.boolean(),
    warnings: z.array(slackWarningSchema),
  })
  .strict();

export const getSlackAppResponseSchema = z
  .object({ slack_app: slackAppSchema.nullable() })
  .strict();

export const slackAppParamsSchema = workspaceParamsSchema
  .extend({ app_id: slackAppIdSchema })
  .strict();

export const slackAppSecretParamsSchema = slackAppParamsSchema
  .extend({ purpose: slackAppSecretPurposeSchema })
  .strict();

export const deleteSlackAppResponseSchema = z
  .object({ slack_app: slackAppSchema })
  .strict();

export const CONFIG_TOKEN_STATE_VALUES = [
  "unset",
  "active",
  "needs_reentry",
] as const;

/**
 * The config token as the console shows it. `needs_reentry`: Slack no
 * longer takes the stored pair, or a rotation's result was lost; an owner
 * or admin pastes a new token.
 */
export const slackConfigTokenSummarySchema = slackSecretSummarySchema
  .extend({
    state: z.enum(CONFIG_TOKEN_STATE_VALUES),
    /** When the current access token expires; it is rotated before then. */
    expires_at: timestampSchema.nullable(),
    issuer: z
      .object({ user_id: slackIdSchema, team_id: slackIdSchema })
      .strict()
      .nullable(),
  })
  .strict();

export const putSlackConfigTokenResponseSchema = slackConfigTokenSummarySchema
  .extend({
    receipt_id: z.uuid(),
    warnings: z.array(slackWarningSchema),
  })
  .strict();

export type SlackAppKind = z.infer<typeof slackAppKindSchema>;
export type SlackAppState = z.infer<typeof slackAppStateSchema>;
export type SlackAppSecretPurpose = z.infer<typeof slackAppSecretPurposeSchema>;
export type SlackApp = z.infer<typeof slackAppSchema>;
export type SlackWarning = z.infer<typeof slackWarningSchema>;
export type CreateSlackAppRequest = z.infer<typeof createSlackAppRequestSchema>;
export type CreateSlackAppResponse = z.infer<
  typeof createSlackAppResponseSchema
>;
export type GetSlackAppResponse = z.infer<typeof getSlackAppResponseSchema>;
export type DeleteSlackAppResponse = z.infer<
  typeof deleteSlackAppResponseSchema
>;
export type SlackConfigTokenSummary = z.infer<
  typeof slackConfigTokenSummarySchema
>;
export type PutSlackConfigTokenResponse = z.infer<
  typeof putSlackConfigTokenResponseSchema
>;

import { z } from "zod";

import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
} from "../shared/index.ts";
import { agentIdentitySchema, slackIdSchema } from "./agent-identities.ts";
import { slackAppSchema } from "./slack-apps.ts";

/** How long an install link's `state` can be completed. */
export const SLACK_INSTALL_STATE_TTL_SECONDS = 600;

export const startSlackInstallResponseSchema = z
  .object({
    /** Slack's consent screen for the agent's app; its `state` is single-use. */
    authorize_url: z.url(),
    expires_at: timestampSchema,
  })
  .strict();

/**
 * What the console's callback page read from Slack's redirect: `code` when
 * the admin approved, `error` (e.g. `access_denied`) when not. `agent_id` is
 * the agent the callback page is for.
 */
export const completeSlackInstallRequestSchema = z
  .object({
    agent_id: agentIdSchema,
    state: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    code: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,2048}$/)
      .optional(),
    error: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
  })
  .strict()
  .refine((body) => (body.code === undefined) !== (body.error === undefined), {
    message: "exactly one of code and error",
  });

export const slackInstallationSchema = z
  .object({
    id: z.uuid(),
    app_id: slackIdSchema,
    team_id: slackIdSchema,
    bot_user_id: slackIdSchema,
    status: z.literal("verified"),
  })
  .strict();

export const completeSlackInstallResponseSchema = z
  .object({
    slack_app: slackAppSchema,
    installation: slackInstallationSchema,
    agent_identity: agentIdentitySchema,
    /** Null when the agent already held this identity. */
    receipt_id: receiptIdSchema.nullable(),
    /** False when the steps after the install failed; the install stands. */
    finalized: z.boolean(),
  })
  .strict();

export type StartSlackInstallResponse = z.infer<
  typeof startSlackInstallResponseSchema
>;
export type CompleteSlackInstallRequest = z.infer<
  typeof completeSlackInstallRequestSchema
>;
export type CompleteSlackInstallResponse = z.infer<
  typeof completeSlackInstallResponseSchema
>;

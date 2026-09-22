import { z } from "zod";

import { timestampSchema, userIdSchema } from "../shared/index.ts";
import {
  principalSchema,
  sessionScopeSchema,
  workspaceRoleSchema,
} from "./authorization.ts";
import {
  displayNameSchema,
  emailSchema,
  workspaceSchema,
  workspaceSlugSchema,
} from "./workspaces.ts";

/** Cookie the web surface authenticates with: HttpOnly, Secure, SameSite=Lax. */
export const WEB_SESSION_COOKIE_NAME = "ap_session";
/** Cookie-path mutations must also carry this header (03 §3.2 CSRF). */
export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "agent-platform-web";

export const LOGIN_LOCKOUT_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_WINDOW_MINUTES = 15;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 1024;
const utf8 = new TextEncoder();

/**
 * A password crosses this boundary exactly twice — login and the two places
 * that set one. It is argon2id-hashed on arrival and appears in no stored,
 * response or projection schema.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .refine(
    (value) => utf8.encode(value).length <= PASSWORD_MAX_BYTES,
    `Password exceeds ${PASSWORD_MAX_BYTES} UTF-8 bytes`,
  );

/** Generated at install, printed once, consumed once (Codex B10). */
export const bootstrapTokenSchema = z.string().min(32).max(256);

export const bootstrapRequestSchema = z
  .object({
    bootstrap_token: bootstrapTokenSchema,
    email: emailSchema,
    password: passwordSchema,
    display_name: displayNameSchema,
    workspace_name: z.string().min(1).max(120),
    workspace_slug: workspaceSlugSchema,
  })
  .strict();
export const bootstrapResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace: workspaceSchema,
    role: workspaceRoleSchema,
  })
  .strict();

export const loginRequestSchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();
export const loginResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace_id: workspaceSchema.shape.id,
    role: workspaceRoleSchema,
    scopes: z.array(sessionScopeSchema),
    expires_at: timestampSchema,
  })
  .strict();

/** What the web app boots from: who is authenticated and under which key. */
export const authMeResponseSchema = z
  .object({
    principal: principalSchema,
    user: z
      .object({
        id: userIdSchema,
        email: emailSchema,
        display_name: displayNameSchema,
      })
      .strict()
      .nullable(),
    workspace: workspaceSchema.nullable(),
    scopes: z.array(sessionScopeSchema),
  })
  .strict();

/**
 * Redeeming an invite. It never touches an existing account's password: a
 * known email joins the workspace, an unknown one gets an account (A02).
 */
export const acceptInviteRequestSchema = z
  .object({
    password: passwordSchema.optional(),
    display_name: displayNameSchema.optional(),
  })
  .strict();
export const acceptInviteResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace: workspaceSchema,
    role: workspaceRoleSchema,
  })
  .strict();

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;

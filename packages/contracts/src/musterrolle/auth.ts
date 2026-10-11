import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import {
  principalSchema,
  scopesExceeding,
  scopesForRole,
  sessionScopeSchema,
  workspaceRoleSchema,
} from "./authorization.ts";
import {
  displayNameSchema,
  emailSchema,
  inviteTokenSchema,
  workspaceSchema,
  workspaceSlugSchema,
} from "./workspaces.ts";

/**
 * Cookie the web surface authenticates with: HttpOnly, Secure, SameSite=Lax.
 * The `__Host-` prefix makes browsers refuse it with a Domain attribute or a
 * Path other than `/`, so a sibling subdomain cannot plant a same-named
 * cookie that shadows the real one (fixation or a lasting 401).
 */
export const WEB_SESSION_COOKIE_NAME = "__Host-ap_session";
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

/** Generated at install, printed once, consumed once. */
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
    /** Bootstrap makes the first owner; a workspace nobody can manage or
     * recover is not a workspace this operation is allowed to leave behind. */
    role: z.literal("owner"),
  })
  .strict();

export const loginRequestSchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();
// A response is where a client builds its own idea of what it may do, so the
// role ceiling has to hold here too — not only on the principal the server
// keeps. Otherwise a cached login body describes a member with recovery.
export const loginResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace_id: workspaceSchema.shape.id,
    role: workspaceRoleSchema,
    scopes: z.array(sessionScopeSchema),
    expires_at: timestampSchema,
  })
  .strict()
  .superRefine((response, ctx) => {
    for (const scope of scopesExceeding(
      response.scopes,
      scopesForRole(response.role),
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: `${response.role} cannot hold ${scope}`,
      });
    }
  });

/**
 * Holds one Google sign-in flow's state, nonce and PKCE verifier. `__Host-`
 * for the reason given at WEB_SESSION_COOKIE_NAME.
 */
export const GOOGLE_LOGIN_COOKIE_NAME = "__Host-ap_google_login";
export const GOOGLE_LOGIN_FLOW_TTL_MINUTES = 10;
export const startGoogleLoginResponseSchema = z
  .object({ authorization_url: z.url() })
  .strict();
export const googleLoginCallbackRequestSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(256),
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
    /** The effective ceiling; it can narrow the principal's, never widen it. */
    scopes: z.array(sessionScopeSchema),
  })
  .strict()
  .superRefine((response, ctx) => {
    for (const scope of scopesExceeding(
      response.scopes,
      response.principal.scopes,
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: `the principal does not hold ${scope}`,
      });
    }
    // The projection is assembled from joins, so say that it must describe
    // the principal that was authenticated — otherwise a mismatched join
    // hands the web client someone else's identity or tenant and it looks
    // valid. The schema cannot know whether the join was correct; it can
    // insist the three parts agree with each other.
    const { principal, user, workspace } = response;
    if (principal.kind === "user") {
      if (user === null || user.id !== principal.id) {
        ctx.addIssue({
          code: "custom",
          path: ["user"],
          message: "must be the authenticated user",
        });
      }
      if (workspace === null || workspace.id !== principal.workspace_id) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace"],
          message: "must be the principal's workspace",
        });
      }
      return;
    }
    // An API key has no human behind it, and a legacy key has no workspace
    // until an explicit mapping exists.
    if (user !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["user"],
        message: "an api key principal has no user",
      });
    }
    const expected = principal.workspace_id;
    if (expected === null ? workspace !== null : workspace?.id !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "must be the workspace the key is mapped to",
      });
    }
  });

/**
 * Redeeming an invite. It never touches an existing account's password: a
 * known email proves it and joins the workspace, an unknown one gets an
 * account with it (A02).
 */
export const acceptInviteRequestSchema = z
  .object({
    /** In the body, never the URL, for the same reason as a reset token. */
    token: inviteTokenSchema,
    password: passwordSchema,
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

/**
 * Account recovery without email (94S-264): an owner issues a one-time link
 * and hands it over; redeeming it sets the password and ends the user's
 * sessions. The token travels in the body, never the URL, so no access log
 * or proxy on the way records it.
 */
export const PASSWORD_RESET_TTL_MINUTES = 60;
export const passwordResetTokenSchema = z.string().min(1).max(256);
export const memberParamsSchema = z
  .object({ id: workspaceIdSchema, userId: userIdSchema })
  .strict();
/**
 * The issuer re-enters their own password: a stolen session cookie alone
 * must not turn into a link that takes over another account.
 */
export const issuePasswordResetRequestSchema = z
  .object({ current_password: passwordSchema })
  .strict();
export const issuePasswordResetResponseSchema = z
  .object({
    user_id: userIdSchema,
    /** Shown once; only its sha256 is stored. */
    token: passwordResetTokenSchema,
    expires_at: timestampSchema,
  })
  .strict();
export const passwordResetRequestSchema = z
  .object({ token: passwordResetTokenSchema, password: passwordSchema })
  .strict();
export const passwordResetResponseSchema = z
  .object({ user_id: userIdSchema, receipt_id: receiptIdSchema })
  .strict();

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
export type StartGoogleLoginResponse = z.infer<
  typeof startGoogleLoginResponseSchema
>;
export type GoogleLoginCallbackRequest = z.infer<
  typeof googleLoginCallbackRequestSchema
>;
export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponseSchema>;
export type IssuePasswordResetRequest = z.infer<
  typeof issuePasswordResetRequestSchema
>;
export type IssuePasswordResetResponse = z.infer<
  typeof issuePasswordResetResponseSchema
>;
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;
export type PasswordResetResponse = z.infer<typeof passwordResetResponseSchema>;

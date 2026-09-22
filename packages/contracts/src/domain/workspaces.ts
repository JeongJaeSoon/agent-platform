import { z } from "zod";

import {
  inviteIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import { workspaceRoleSchema } from "./authorization.ts";

export { WORKSPACE_ROLE_VALUES, workspaceRoleSchema } from "./authorization.ts";

export const workspaceSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase kebab-case");
export const emailSchema = z.email().max(254);
export const displayNameSchema = z.string().min(1).max(64);

/** Emails are compared lower-cased; store what this returns. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const workspaceSettingsSchema = z
  .object({
    /** Model the dispatch classifier uses; null falls back to the deployment default. */
    dispatch_model: z.string().min(1).max(128).nullable().default(null),
    /** Workspace-wide stop: new dispatches become needs_confirm only (03 §7). */
    kill_switch: z.boolean().default(false),
    daily_cost_limit_usd: z.number().nonnegative().nullable().default(null),
    /** Minutes of silence before the reconciler pauses a session (Codex E05). */
    idle_pause_minutes: z.number().int().positive().default(30),
  })
  .strict();

export const workspaceSchema = z
  .object({
    id: workspaceIdSchema,
    slug: workspaceSlugSchema,
    name: z.string().min(1).max(120),
    settings: workspaceSettingsSchema,
    created_at: timestampSchema,
  })
  .strict();

export const userSchema = z
  .object({
    id: userIdSchema,
    email: emailSchema,
    display_name: displayNameSchema,
    created_at: timestampSchema,
    /** Account suspension, kept distinct from losing one membership (A03). */
    disabled_at: timestampSchema.nullable(),
  })
  .strict();

export const membershipSchema = z
  .object({
    workspace_id: workspaceIdSchema,
    user_id: userIdSchema,
    role: workspaceRoleSchema,
    created_at: timestampSchema,
    disabled_at: timestampSchema.nullable(),
  })
  .strict();

export const memberViewSchema = z
  .object({
    user_id: userIdSchema,
    email: emailSchema,
    display_name: displayNameSchema,
    role: workspaceRoleSchema,
    disabled_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const INVITE_STATUS_VALUES = [
  "pending",
  "accepted",
  "revoked",
  "expired",
] as const;
export const inviteStatusSchema = z.enum(INVITE_STATUS_VALUES);

/**
 * The stored invite. It deliberately has no token field: only the hash is
 * persisted, so a leaked row cannot be redeemed.
 */
export const inviteSchema = z
  .object({
    id: inviteIdSchema,
    workspace_id: workspaceIdSchema,
    email: emailSchema,
    role: workspaceRoleSchema,
    invited_by: userIdSchema,
    status: inviteStatusSchema,
    expires_at: timestampSchema,
    accepted_at: timestampSchema.nullable(),
    revoked_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict()
  .superRefine((invite, ctx) => {
    // The status and the audit timestamps answer the same question — is this
    // still redeemable — so they cannot give different answers. `expired` is
    // the one status with no timestamp of its own: `expires_at` already
    // carries it, and a row is expired by the clock rather than by a write.
    const stamped = {
      accepted: invite.accepted_at,
      revoked: invite.revoked_at,
    } as const;
    for (const [status, at] of Object.entries(stamped)) {
      const field = `${status}_at` as const;
      if (invite.status === status && at === null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `a ${status} invite carries its ${field}`,
        });
      }
      if (invite.status !== status && at !== null) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `only a ${status} invite carries ${field}`,
        });
      }
    }
  });

export const createInviteRequestSchema = z
  .object({ email: emailSchema, role: workspaceRoleSchema })
  .strict();

/**
 * The only place an invite token ever appears. It is returned once, to the
 * inviter, and never read back from storage.
 */
export const createInviteResponseSchema = z
  .object({
    invite_id: inviteIdSchema,
    invite_token: z.string().min(32).max(256),
    expires_at: timestampSchema,
  })
  .strict();

export const updateMemberRequestSchema = z
  .object({
    role: workspaceRoleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "at least one field is required",
  );

export const listMembersResponseSchema = z
  .object({ items: z.array(memberViewSchema) })
  .strict();
export const listInvitesResponseSchema = z
  .object({ items: z.array(inviteSchema) })
  .strict();

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type User = z.infer<typeof userSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type MemberView = z.infer<typeof memberViewSchema>;
export type InviteStatus = z.infer<typeof inviteStatusSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;
export type ListMembersResponse = z.infer<typeof listMembersResponseSchema>;
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

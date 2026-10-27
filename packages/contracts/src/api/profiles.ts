import { z } from "zod";
import { receiptIdSchema, timestampSchema } from "../shared/ids.ts";
import { permissionModeSchema, runtimeKindSchema } from "./session.ts";

/**
 * Whether a session of the profile names a repository: `required` always,
 * `optional` may, `none` never.
 */
export const repositoryModeSchema = z.enum(["required", "optional", "none"]);

/**
 * Where a profile is defined: the operator's catalog file, or a workspace
 * owner or admin in the console, narrowing one operator profile.
 */
export const profileSourceSchema = z.enum(["operator", "workspace"]);

/**
 * Whether a workspace profile takes new releases and sessions. Only
 * `usable` does. `base_changed`: the operator changed the profile it narrows
 * since it was made, so it and the sessions made on it stop until the
 * operator restores the base or someone makes a new version. `base_missing`:
 * the operator removed the base. `retired`: an owner or admin retired it;
 * what already uses it keeps running.
 */
export const workspaceProfileStateSchema = z.enum([
  "usable",
  "base_changed",
  "base_missing",
  "retired",
]);

export const workspaceProfileNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/**
 * How long a session of the profile waits on a permission or question
 * request, as resolved for new sessions, and where each value came from:
 * the profile, or the installation default where the profile sets none. A
 * session may only shorten them (`permission_wait` at create).
 */
const permissionWaitSourceSchema = z.enum(["profile", "installation"]);
export const permissionWaitSchema = z
  .object({
    park_after_seconds: z.number().int().nonnegative(),
    expire_after_seconds: z.number().int().positive(),
    source: z
      .object({
        park_after_seconds: permissionWaitSourceSchema,
        expire_after_seconds: permissionWaitSourceSchema,
      })
      .strict(),
  })
  .strict();

/**
 * GET /v1/profiles: the profiles a session or a release may name, the
 * operator's and this workspace's. Only what a caller picks by; the
 * provider endpoint and credential reference stay with the operator.
 */
export const profileSummarySchema = z
  .object({
    id: z.string().min(1),
    source: profileSourceSchema,
    // The default; `models` lists every model a session may name, it first.
    model: z.string().min(1),
    models: z.array(z.string().min(1)).min(1),
    tools: z.array(z.string().min(1)),
    permission_mode: permissionModeSchema,
    runtime_kind: runtimeKindSchema,
    runtime_version: z.string().min(1),
    // `none`: the profile declared `billing: none`, so its sessions run at
    // no recorded cost and with no dollar limit.
    billing: z.enum(["metered", "none"]),
    repository_mode: repositoryModeSchema,
    // Optional so a reader ahead of its server reads a profile without it.
    repository_ids: z.array(z.string().min(1)).optional().meta({
      description:
        "The catalog repositories that allow this profile, which a session or an agent release of it may name as `repository_id`.",
    }),
    // Optional so a reader ahead of its server reads a profile without it.
    permission_wait: permissionWaitSchema.optional(),
    // Set exactly when `source` is `workspace`.
    workspace: z
      .object({
        name: workspaceProfileNameSchema,
        version: z.number().int().min(1),
        base_profile_id: z.string().min(1),
        state: workspaceProfileStateSchema,
        created_at: timestampSchema,
        retired_at: timestampSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const listProfilesResponseSchema = z
  .object({ items: z.array(profileSummarySchema) })
  .strict();

/** A slug that is not id-safe gives way to the workspace's uuid. */
export function workspaceProfileId(
  workspace: { readonly id: string; readonly slug: string },
  name: string,
  version: number,
): string {
  const prefix = /^[a-z0-9-]+$/.test(workspace.slug)
    ? workspace.slug
    : workspace.id;
  return `ws_${prefix}_${name}_v${version}`;
}

/**
 * POST /v1/workspace-profiles: a new version of the workspace profile
 * `name`, narrowing the operator profile `base_profile_id`. Its id is new
 * (`ws_<workspace slug>_<name>_v<n>`); earlier versions stay as they were.
 */
export const createWorkspaceProfileRequestSchema = z
  .object({
    name: workspaceProfileNameSchema,
    base_profile_id: z.string().min(1).max(200),
    // The default model, one of `models`.
    model: z.string().min(1).max(200),
    models: z.array(z.string().min(1).max(200)).min(1).max(32),
    tools: z.array(z.string().min(1).max(200)).max(64),
    permission_mode: permissionModeSchema,
  })
  .strict();

export const workspaceProfileIdParamsSchema = z
  .object({ profile_id: z.string().min(1).max(200) })
  .strict();

export const workspaceProfileChangeResponseSchema = z
  .object({
    profile: profileSummarySchema,
    /** Null when the profile already was what was asked: nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export type RepositoryMode = z.infer<typeof repositoryModeSchema>;
export type ProfileSource = z.infer<typeof profileSourceSchema>;
export type WorkspaceProfileState = z.infer<typeof workspaceProfileStateSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;
export type CreateWorkspaceProfileRequest = z.infer<
  typeof createWorkspaceProfileRequestSchema
>;
export type WorkspaceProfileChangeResponse = z.infer<
  typeof workspaceProfileChangeResponseSchema
>;

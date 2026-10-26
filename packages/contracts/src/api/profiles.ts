import { z } from "zod";

/**
 * Whether a session of the profile names a repository: `required` always,
 * `optional` may, `none` never.
 */
export const repositoryModeSchema = z.enum(["required", "optional", "none"]);

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
 * GET /v1/profiles: the catalog profiles a session or a release may name.
 * Only what a caller picks by; the provider endpoint and credential
 * reference stay with the operator.
 */
export const profileSummarySchema = z
  .object({
    id: z.string().min(1),
    model: z.string().min(1),
    tools: z.array(z.string().min(1)),
    runtime_kind: z.literal("claude_agent_sdk"),
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
  })
  .strict();

export const listProfilesResponseSchema = z
  .object({ items: z.array(profileSummarySchema) })
  .strict();

export type RepositoryMode = z.infer<typeof repositoryModeSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;

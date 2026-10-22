import { z } from "zod";

/**
 * Whether a session of the profile names a repository: `required` always,
 * `optional` may, `none` never.
 */
export const repositoryModeSchema = z.enum(["required", "optional", "none"]);

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
  })
  .strict();

export const listProfilesResponseSchema = z
  .object({ items: z.array(profileSummarySchema) })
  .strict();

export type RepositoryMode = z.infer<typeof repositoryModeSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;

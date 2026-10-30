import { z } from "zod";

import { agentGitHubSchema } from "../kollegium/agents.ts";
import { receiptIdSchema } from "../shared/index.ts";
import { receiptSchema } from "./receipt.ts";

/** Why an optional permission cannot be turned on in the agent's GitHub tab. */
export const AGENT_GITHUB_FEATURE_UNAVAILABLE_VALUES = [
  // The App's permissions as last read lack it (a cached value; the token
  // request decides).
  "app_permission_missing",
  "over_workspace_ceiling",
  "no_reviewer_app",
  // Every repository the settings name is on a GitHub Enterprise host.
  "github_host_unsupported",
] as const;

/** Why a catalog repository cannot be picked. */
export const AGENT_GITHUB_REPOSITORY_UNAVAILABLE_VALUES = [
  // The release's runtime profile does not allow it.
  "repository_not_allowed",
  // A PAT repository: its token cannot be narrowed.
  "app_required",
] as const;

/** Why the release settings cannot be saved at all. */
export const AGENT_GITHUB_UNSAVABLE_VALUES = [
  "no_active_release",
  "repository_none",
  // The active release's repository is a PAT one.
  "app_required",
] as const;

const featureOptionSchema = z.object({
  available: z.boolean(),
  reason: z.enum(AGENT_GITHUB_FEATURE_UNAVAILABLE_VALUES).nullable(),
});

export const agentGitHubResponseSchema = z.object({
  /** `agents.github_enabled`: applies at once, not through a release. */
  enabled: z.boolean(),
  active_release_id: z.string().nullable(),
  /** The active release's repository; it must stay among `repositories`. */
  release_repository_id: z.string().nullable(),
  /** The active release's `policy_pins.github`. */
  github: agentGitHubSchema.nullable(),
  /**
   * When `github` is null and the release has a repository: what a first
   * save starts from (its repository alone, push approval on, nothing
   * optional). Until then the release runs as before, on every repository
   * its profile allows.
   */
  legacy_defaults: agentGitHubSchema.nullable(),
  unsavable: z.enum(AGENT_GITHUB_UNSAVABLE_VALUES).nullable(),
  options: z.object({
    /** The catalog's GitHub repositories. */
    repositories: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        available: z.boolean(),
        reason: z.enum(AGENT_GITHUB_REPOSITORY_UNAVAILABLE_VALUES).nullable(),
      }),
    ),
    features: z.object({
      workflows: featureOptionSchema,
      actions: featureOptionSchema,
      checks: featureOptionSchema,
      issues: featureOptionSchema,
      review: featureOptionSchema,
    }),
  }),
});

export const putAgentGitHubEnabledRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

/** `receipt_id` is null when the switch already held that value. */
export const putAgentGitHubEnabledResponseSchema = z.object({
  enabled: z.boolean(),
  receipt_id: receiptIdSchema.nullable(),
});

export const AGENT_GITHUB_ACTIVITY_LIMIT = 20;

/**
 * The agent's latest GitHub receipts, newest first: switch changes, releases
 * and activations that changed its GitHub settings, and the gate's work on
 * sessions the caller can see.
 */
export const agentGitHubActivityResponseSchema = z.object({
  items: z.array(receiptSchema).max(AGENT_GITHUB_ACTIVITY_LIMIT),
});

export type AgentGitHubResponse = z.infer<typeof agentGitHubResponseSchema>;
export type AgentGitHubFeatureUnavailable =
  (typeof AGENT_GITHUB_FEATURE_UNAVAILABLE_VALUES)[number];
export type AgentGitHubRepositoryUnavailable =
  (typeof AGENT_GITHUB_REPOSITORY_UNAVAILABLE_VALUES)[number];
export type PutAgentGitHubEnabledRequest = z.infer<
  typeof putAgentGitHubEnabledRequestSchema
>;
export type PutAgentGitHubEnabledResponse = z.infer<
  typeof putAgentGitHubEnabledResponseSchema
>;
export type AgentGitHubActivityResponse = z.infer<
  typeof agentGitHubActivityResponseSchema
>;

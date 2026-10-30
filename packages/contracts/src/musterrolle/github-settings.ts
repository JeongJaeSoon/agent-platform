import { z } from "zod";

// Imports zod only: kollegium/agents.ts pins these on a release, and
// github-app.ts sits on an import cycle through workspaces.ts.

/**
 * `author` clones, pushes and opens pull requests; `reviewer` only reviews,
 * since GitHub refuses an approval from the pull request's own author. The
 * `/github-app` routes are the author's.
 */
export const GITHUB_APP_ROLE_VALUES = ["author", "reviewer"] as const;
export const githubAppRoleSchema = z.enum(GITHUB_APP_ROLE_VALUES);

/** The optional permissions an agent may be given, beyond writing a PR. */
export const githubFeaturesSchema = z
  .object({
    workflows: z.boolean(),
    actions: z.boolean(),
    checks: z.boolean(),
    issues: z.boolean(),
    review: z.boolean(),
  })
  .strict();

/** What a workspace lets its agents turn on; no settings row reads all false. */
export const githubCeilingSchema = githubFeaturesSchema;

export const GITHUB_CEILING_NONE: GitHubCeiling = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};

/** `details.reason_code` of a refused GitHub token (`GITHUB_REFUSED`). */
export const GITHUB_REFUSAL_VALUES = [
  "github_disabled",
  "repository_not_allowed",
  "feature_off",
  "over_workspace_ceiling",
  "app_permission_missing",
  "no_reviewer_app",
  "app_required",
  "workflow_not_allowed",
  "agent_ref_refused",
  "run_ref_unprovable",
  "actions_off",
  // The session's release carries GitHub settings this server cannot apply.
  "github_settings_unsupported",
  "github_host_unsupported",
  "repository_none",
] as const;
export const githubRefusalSchema = z.enum(GITHUB_REFUSAL_VALUES);

export type GitHubAppRole = z.infer<typeof githubAppRoleSchema>;
export type GitHubFeatures = z.infer<typeof githubFeaturesSchema>;
export type GitHubCeiling = z.infer<typeof githubCeilingSchema>;
export type GitHubRefusal = (typeof GITHUB_REFUSAL_VALUES)[number];

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

/** Refusals of policy (403); the rest name a missing setting or a ceiling (409). */
const GITHUB_POLICY_REFUSALS: ReadonlySet<GitHubRefusal> = new Set([
  "github_disabled",
  "repository_not_allowed",
  "feature_off",
  "workflow_not_allowed",
  "agent_ref_refused",
  "run_ref_unprovable",
]);

export function githubRefusalStatus(reason: unknown): 403 | 409 {
  return GITHUB_POLICY_REFUSALS.has(reason as GitHubRefusal) ? 403 : 409;
}

/** What a GitHub token is asked for; each has one row of permissions. */
export const GITHUB_PURPOSE_VALUES = [
  "clone",
  "push",
  "pull_request",
  "actions_read",
  "dispatch",
  "rerun",
  "review",
  // GA-4b: the platform reading a pull request it recorded.
  "outcome_refresh",
] as const;
export const githubPurposeSchema = z.enum(GITHUB_PURPOSE_VALUES);

export type GitHubPermissionLevel = "read" | "write";

/**
 * The permission table: what a purpose asks GitHub for, from which App, and
 * the optional feature it needs (null: the default work every agent has).
 * `push` adds `workflows: write` when the release turns workflows on.
 */
export function githubPermissionsFor(
  purpose: GitHubPurpose,
  features: Pick<GitHubFeatures, "workflows">,
): {
  role: GitHubAppRole;
  feature: keyof GitHubFeatures | null;
  permissions: Record<string, GitHubPermissionLevel>;
} {
  switch (purpose) {
    case "clone":
      return {
        role: "author",
        feature: null,
        permissions: { contents: "read" },
      };
    case "push":
      return {
        role: "author",
        feature: null,
        permissions: features.workflows
          ? { contents: "write", workflows: "write" }
          : { contents: "write" },
      };
    case "pull_request":
      return {
        role: "author",
        feature: null,
        permissions: { contents: "read", pull_requests: "write" },
      };
    case "actions_read":
      return {
        role: "author",
        feature: "actions",
        permissions: { actions: "read" },
      };
    case "dispatch":
    case "rerun":
      return {
        role: "author",
        feature: "actions",
        permissions: { actions: "write" },
      };
    case "review":
      return {
        role: "reviewer",
        feature: "review",
        permissions: { contents: "read", pull_requests: "write" },
      };
    case "outcome_refresh":
      return {
        role: "author",
        feature: null,
        permissions: { pull_requests: "read" },
      };
  }
}

/**
 * The ceiling policy, shared by saving a release (refused when it is over)
 * and by every token issue (a feature over it is refused then): the features
 * turned on that the workspace does not allow.
 */
export function githubFeaturesOverCeiling(
  features: GitHubFeatures,
  ceiling: GitHubCeiling,
): (keyof GitHubFeatures)[] {
  return (Object.keys(features) as (keyof GitHubFeatures)[]).filter(
    (feature) => features[feature] && !ceiling[feature],
  );
}

/** The features a release may use now: on in it and under the ceiling. */
export function githubEffectiveFeatures(
  features: GitHubFeatures,
  ceiling: GitHubCeiling,
): GitHubFeatures {
  return {
    workflows: features.workflows && ceiling.workflows,
    actions: features.actions && ceiling.actions,
    checks: features.checks && ceiling.checks,
    issues: features.issues && ceiling.issues,
    review: features.review && ceiling.review,
  };
}

/** The branches the platform pushes to; never run by a dispatch. */
export const GITHUB_AGENT_REF_PREFIX = "agent/";

/**
 * An allow-list `ref` against a branch: literal but for `*`, which matches
 * any run of characters other than `/`.
 */
export function githubRefMatches(pattern: string, ref: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(ref);
}

/**
 * The allow-list entry that lets `workflow` run on branch `ref`, or null.
 * An entry without `ref` means the repository's default branch only.
 */
export function githubAllowedBy<
  Entry extends { workflow: string; ref?: string | undefined },
>(
  allow: readonly Entry[],
  workflow: string,
  ref: string,
  defaultBranch: string,
): Entry | null {
  return (
    allow.find(
      (entry) =>
        entry.workflow === workflow &&
        (entry.ref === undefined
          ? ref === defaultBranch
          : githubRefMatches(entry.ref, ref)),
    ) ?? null
  );
}

const githubAppPermissionsSchema = z.record(
  z.string(),
  z.enum(["read", "write", "admin"]),
);

/**
 * Linking people's GitHub accounts, through the author App's user
 * authorization. The client secret is never read back.
 */
export const githubOAuthSchema = z.object({
  /** The author App's, as GitHub last gave it; null without an App or a read. */
  client_id: z.string().nullable(),
  client_secret_set: z.boolean(),
  /** What the App's Callback URL must be; null when the console has no origin. */
  callback_url: z.url().nullable(),
});

export const githubSettingsResponseSchema = z.object({
  ceiling: githubCeilingSchema,
  /** 0 until the ceiling is first saved. */
  revision: z.number().int().nonnegative(),
  /**
   * Per feature: agents with GitHub on whose active release turns it on.
   * Sessions of earlier releases are not counted.
   */
  agents_using: z.object({
    workflows: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    checks: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
  }),
  oauth: githubOAuthSchema,
  /** The App's permissions as last read from GitHub; null before a read. */
  apps: z.object({
    author: z
      .object({ permissions: githubAppPermissionsSchema.nullable() })
      .nullable(),
    reviewer: z
      .object({ permissions: githubAppPermissionsSchema.nullable() })
      .nullable(),
  }),
});

/** CAS on `revision`: a stale one answers 409 REVISION_CONFLICT. */
export const putGitHubSettingsRequestSchema = z
  .object({
    ceiling: githubCeilingSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

// Printable ASCII without spaces, as GitHub hands it out; a pasted space or
// newline is refused rather than kept. The same rule as the Slack secrets
// (secretValueSchema), restated here to keep this file on zod alone.
export const putGitHubOAuthClientSecretRequestSchema = z
  .object({
    client_secret: z
      .string()
      .min(8)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces"),
  })
  .strict();

export const putGitHubOAuthClientSecretResponseSchema = z.object({
  receipt_id: z.uuid(),
  oauth: githubOAuthSchema,
});

export type GitHubOAuth = z.infer<typeof githubOAuthSchema>;
export type PutGitHubOAuthClientSecretRequest = z.infer<
  typeof putGitHubOAuthClientSecretRequestSchema
>;
export type PutGitHubOAuthClientSecretResponse = z.infer<
  typeof putGitHubOAuthClientSecretResponseSchema
>;
export type GitHubSettingsResponse = z.infer<
  typeof githubSettingsResponseSchema
>;
export type PutGitHubSettingsRequest = z.infer<
  typeof putGitHubSettingsRequestSchema
>;
export type GitHubPurpose = z.infer<typeof githubPurposeSchema>;
export type GitHubAppRole = z.infer<typeof githubAppRoleSchema>;
export type GitHubFeatures = z.infer<typeof githubFeaturesSchema>;
export type GitHubCeiling = z.infer<typeof githubCeilingSchema>;
export type GitHubRefusal = (typeof GITHUB_REFUSAL_VALUES)[number];

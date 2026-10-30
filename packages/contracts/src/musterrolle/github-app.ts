import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { githubAppRoleSchema } from "./github-settings.ts";
import { displayNameSchema, workspaceParamsSchema } from "./workspaces.ts";

// The workspace's GitHub Apps, registered in the console: the author App,
// with which catalog repositories whose `auth` is `{ kind: github_app }`
// clone, push and open pull requests, and an optional reviewer App that only
// reviews. A private key goes in once and is never read back.

export const githubAppRoleParamsSchema = workspaceParamsSchema
  .extend({ role: githubAppRoleSchema })
  .strict();

/** `details.reason_code` of a refused `PUT …/github-apps/{role}` (409). */
export const GITHUB_APP_CONFLICT_VALUES = [
  // The other role holds the same App: GitHub refuses an approval from the
  // App that opened the pull request.
  "same_app",
  // A reviewer App needs the author App first.
  "no_author_app",
] as const;

export const GITHUB_APP_PRIVATE_KEY_MAX_LENGTH = 16_384;

export const githubAppIdSchema = z.number().int().positive().max(2_147_483_647);

export const putGitHubAppRequestSchema = z
  .object({
    app_id: githubAppIdSchema,
    /** The PEM GitHub issued for the App ("Generate a private key"). */
    private_key: z.string().min(1).max(GITHUB_APP_PRIVATE_KEY_MAX_LENGTH),
  })
  .strict();

const updatedBySchema = z
  .object({ user_id: userIdSchema, display_name: displayNameSchema })
  .strict()
  .nullable();

export const githubAppPermissionLevelSchema = z.enum([
  "read",
  "write",
  "admin",
]);
export type GitHubAppPermissionLevel = z.infer<
  typeof githubAppPermissionLevelSchema
>;
export const githubAppPermissionsSchema = z.record(
  z.string().min(1),
  githubAppPermissionLevelSchema,
);
export type GitHubAppPermissions = z.infer<typeof githubAppPermissionsSchema>;

const RANK: Record<GitHubAppPermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * The most each role's App is told to hold (design github-agent.md §1):
 * the author's defaults plus its optional features, the reviewer's three.
 */
export const GITHUB_APP_PERMISSION_GUIDANCE: Record<
  "author" | "reviewer",
  GitHubAppPermissions
> = {
  author: {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    actions: "write",
    checks: "write",
    issues: "write",
    workflows: "write",
  },
  reviewer: { contents: "read", pull_requests: "write", metadata: "read" },
};

export const githubAppWarningSchema = z
  .object({
    permission: z.string().min(1),
    level: githubAppPermissionLevelSchema,
    /** The most the guidance names; null when it names none. */
    guided: githubAppPermissionLevelSchema.nullable(),
  })
  .strict();
export type GitHubAppWarning = z.infer<typeof githubAppWarningSchema>;

/** Permissions wider than the role's guidance. Saving is not refused. */
export function githubAppWarnings(
  role: "author" | "reviewer",
  permissions: GitHubAppPermissions | null,
): GitHubAppWarning[] {
  const guidance = GITHUB_APP_PERMISSION_GUIDANCE[role];
  return Object.entries(permissions ?? {})
    .filter(([name, level]) => {
      const guided = guidance[name];
      return guided === undefined || RANK[level] > RANK[guided];
    })
    .map(([permission, level]) => ({
      permission,
      level,
      guided: guidance[permission] ?? null,
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}

export const githubAppSchema = z
  .object({
    /** Absent from servers before the reviewer App: the author. */
    role: githubAppRoleSchema.optional(),
    app_id: githubAppIdSchema,
    slug: z.string().min(1),
    name: z.string().min(1),
    /** The App's page on GitHub; its `/installations/new` installs it. */
    html_url: z.string().url(),
    private_key: z
      .object({
        updated_at: timestampSchema,
        /** The console user who last set it; null once that account is gone. */
        updated_by: updatedBySchema,
      })
      .strict(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    /**
     * What the App asks for (`GET /app`), as last read; null before the
     * first read. An installation grants a raise only once it is approved.
     */
    permissions: githubAppPermissionsSchema.nullable().optional(),
    permissions_checked_at: timestampSchema.nullable().optional(),
    /** Permissions wider than the role's guidance. */
    warnings: z.array(githubAppWarningSchema).optional(),
  })
  .strict();

export const githubAppInstallationSchema = z
  .object({
    id: z.number().int().positive(),
    /** The user or organization login the App is installed on. */
    account: z.string().min(1),
    repository_selection: z.enum(["all", "selected"]),
    html_url: z.string().url().nullable(),
  })
  .strict();

export const githubAppRepositorySchema = z
  .object({
    /** The catalog repository id. */
    id: z.string().min(1),
    url: z.string().url(),
    /** Null while the App is not installed on the repository. */
    installation_id: z.number().int().positive().nullable(),
    /**
     * What that installation grants, as GitHub answered now. It trails the
     * App's own permissions until an owner approves a raise on GitHub.
     */
    installation_permissions: githubAppPermissionsSchema.nullable().optional(),
  })
  .strict();

export const GITHUB_APP_CHECK_FAILURE_VALUES = [
  // GitHub did not answer, or answered with a server error.
  "github_unreachable",
  // GitHub refused the App's own token: the key was revoked or the App deleted.
  "github_rejected",
] as const;

export const getGitHubAppResponseSchema = z
  .object({
    github_app: githubAppSchema.nullable(),
    /**
     * The App as GitHub sees it now. Null with no App registered; a failed
     * check leaves `installations` empty and every `installation_id` null.
     */
    check: z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("ok") }).strict(),
        z
          .object({
            state: z.literal("failed"),
            reason_code: z.enum(GITHUB_APP_CHECK_FAILURE_VALUES),
          })
          .strict(),
      ])
      .nullable(),
    installations: z.array(githubAppInstallationSchema),
    /** Catalog repositories that use the registered Apps. */
    repositories: z.array(githubAppRepositorySchema),
  })
  .strict();

export const putGitHubAppResponseSchema = z
  .object({ github_app: githubAppSchema, receipt_id: receiptIdSchema })
  .strict();

export const deleteGitHubAppResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

export type GitHubAppConflict = (typeof GITHUB_APP_CONFLICT_VALUES)[number];
export type PutGitHubAppRequest = z.infer<typeof putGitHubAppRequestSchema>;
export type GitHubApp = z.infer<typeof githubAppSchema>;
export type GitHubAppInstallation = z.infer<typeof githubAppInstallationSchema>;
export type GitHubAppRepository = z.infer<typeof githubAppRepositorySchema>;
export type GitHubAppCheckFailure =
  (typeof GITHUB_APP_CHECK_FAILURE_VALUES)[number];
export type GetGitHubAppResponse = z.infer<typeof getGitHubAppResponseSchema>;
export type PutGitHubAppResponse = z.infer<typeof putGitHubAppResponseSchema>;
export type DeleteGitHubAppResponse = z.infer<
  typeof deleteGitHubAppResponseSchema
>;

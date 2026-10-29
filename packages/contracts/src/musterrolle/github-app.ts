import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { displayNameSchema } from "./workspaces.ts";

// The workspace's GitHub App, registered in the console (one per workspace
// for now). Catalog repositories whose `auth` is `{ kind: github_app }` clone,
// push and open pull requests with it. The private key goes in once and is
// never read back.

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

export const githubAppSchema = z
  .object({
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
    /** Catalog repositories that use the registered App. */
    repositories: z.array(githubAppRepositorySchema),
  })
  .strict();

export const putGitHubAppResponseSchema = z
  .object({ github_app: githubAppSchema, receipt_id: receiptIdSchema })
  .strict();

export const deleteGitHubAppResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

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

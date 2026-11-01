import { z } from "zod";

import {
  githubPurposeSchema,
  githubRefusalSchema,
} from "../musterrolle/github-settings.ts";
import { receiptIdSchema, timestampSchema } from "../shared/index.ts";

/**
 * What a session made, by kind (design github-agent.md §10). Only the server
 * writes an outcome; a type is added by a migration widening the table's
 * CHECK together with its states here.
 */
export const SESSION_OUTCOME_TYPE_VALUES = ["github_pull_request"] as const;

export const GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES = [
  "open",
  "merged",
  "closed",
] as const;

/** Why the last read of an outcome's state failed; its state is left as it was. */
export const SESSION_OUTCOME_CHECK_ERROR_VALUES = [
  "not_found",
  "forge_failed",
  "github_refused",
] as const;

export const sessionOutcomeTypeSchema = z.enum(SESSION_OUTCOME_TYPE_VALUES);
export const sessionOutcomeCheckErrorSchema = z.enum(
  SESSION_OUTCOME_CHECK_ERROR_VALUES,
);

/**
 * A pull request outcome's metadata. `adopted` is true when the platform
 * answered a pull request it did not create (one already open for the
 * session's branch), null when that is unknown (a row filled in later). The
 * size fields are null until the first read of the pull request.
 */
export const githubPullRequestOutcomeMetadataSchema = z.object({
  head: z.string(),
  base: z.string(),
  adopted: z.boolean().nullable(),
  merge_commit_sha: z.string().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  changed_files: z.number().int().nonnegative().nullable(),
  commits: z.number().int().nonnegative().nullable(),
});

export const sessionOutcomeSchema = z.object({
  id: z.uuid(),
  type: sessionOutcomeTypeSchema,
  url: z.url(),
  repository_id: z.string().nullable(),
  external_id: z.string().nullable(),
  state: z.enum(GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES),
  state_changed_at: timestampSchema,
  merged_at: timestampSchema.nullable(),
  closed_at: timestampSchema.nullable(),
  // When the platform last had GitHub's answer; the state is as of then.
  state_checked_at: timestampSchema.nullable(),
  check_error: sessionOutcomeCheckErrorSchema.nullable(),
  metadata: githubPullRequestOutcomeMetadataSchema,
  created_at: timestampSchema,
});

/** GET /v1/sessions/{id}/outcomes: oldest first. */
export const listSessionOutcomesResponseSchema = z.object({
  items: z.array(sessionOutcomeSchema),
});

/** The most refusals GET /v1/sessions/{id}/github/refusals lists. */
export const SESSION_GITHUB_REFUSALS_LIMIT = 10;

/** One refusal of the GitHub gate for the session, as its receipt names it. */
export const sessionGitHubRefusalSchema = z.object({
  receipt_id: receiptIdSchema,
  operation: z.enum([
    "mint_github_token",
    "dispatch_workflow",
    "rerun_workflow",
    "review_pull_request",
  ]),
  purpose: githubPurposeSchema,
  reason_code: githubRefusalSchema,
  created_at: timestampSchema,
});

/** GET /v1/sessions/{id}/github/refusals: newest first. */
export const listSessionGitHubRefusalsResponseSchema = z.object({
  items: z.array(sessionGitHubRefusalSchema),
});

export type SessionOutcomeType = (typeof SESSION_OUTCOME_TYPE_VALUES)[number];
export type GitHubPullRequestOutcomeState =
  (typeof GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES)[number];
export type SessionOutcomeCheckError =
  (typeof SESSION_OUTCOME_CHECK_ERROR_VALUES)[number];
export type GitHubPullRequestOutcomeMetadata = z.infer<
  typeof githubPullRequestOutcomeMetadataSchema
>;
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>;
export type ListSessionOutcomesResponse = z.infer<
  typeof listSessionOutcomesResponseSchema
>;
export type SessionGitHubRefusal = z.infer<typeof sessionGitHubRefusalSchema>;
export type ListSessionGitHubRefusalsResponse = z.infer<
  typeof listSessionGitHubRefusalsResponseSchema
>;

import { z } from "zod";

import { receiptIdSchema, timestampSchema } from "../shared/index.ts";
import { workspaceParamsSchema } from "./workspaces.ts";

// The catalog's GitHub repositories as the console manages them: rows added
// from the author App's installations (decision repository-catalog-db.md),
// shown beside the operator file's entries, which stay read-only.

export const CATALOG_REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const catalogRepositoryIdSchema = z
  .string()
  .regex(CATALOG_REPOSITORY_ID_PATTERN);

// A git branch name, short of git's full ref rules: no whitespace or control
// characters, none git refuses, no `..`, `@{`, `//` or component starting
// with `.`, no leading `-` or `/`, no trailing `/` or `.lock`.
export const repositoryBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    // No `u` flag and no \p{…}: the pattern is published in the OpenAPI
    // document, and clients compile it as a plain regex.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
    /^(?![-/.])(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\/\.)(?!.*\/$)(?!.*\.lock$)[^\s\x00-\x1f\x7f~^:?*[\\]+$/,
  );

export const githubRepositoryParamsSchema = workspaceParamsSchema
  .extend({ repositoryId: z.string().min(1).max(200) })
  .strict();

export const CATALOG_REPOSITORY_SOURCE_VALUES = [
  "console",
  "seed",
  "file",
] as const;

export const catalogGitHubRepositorySchema = z
  .object({
    id: z.string().min(1),
    /** Null for a file entry, and for a seeded one until GitHub is asked. */
    github_repository_id: z.number().int().positive().nullable(),
    full_name: z.string().min(1).nullable(),
    url: z.string().url(),
    branch: z.string().min(1),
    source: z.enum(CATALOG_REPOSITORY_SOURCE_VALUES),
    /** False for a file entry: the operator's file decides it. */
    editable: z.boolean(),
    /** For PATCH; null for a file entry. */
    version: z.number().int().positive().nullable(),
    /** Whether the author App is installed on it; null if GitHub was not asked. */
    installed: z.boolean().nullable(),
    updated_at: timestampSchema.nullable(),
  })
  .strict();

export const listGitHubRepositoriesResponseSchema = z
  .object({ repositories: z.array(catalogGitHubRepositorySchema) })
  .strict();

export const githubRepositoryCandidateSchema = z
  .object({
    github_repository_id: z.number().int().positive(),
    full_name: z.string().min(1),
    /** The installation's account: the organization or user. */
    account: z.string().min(1),
    default_branch: z.string().min(1),
    private: z.boolean(),
    /** The catalog id when it is in the catalog already. */
    catalog_id: z.string().min(1).nullable(),
  })
  .strict();

export const GITHUB_REPOSITORY_CANDIDATES_UNAVAILABLE_VALUES = [
  // No author App is registered.
  "no_author_app",
  "github_unreachable",
  "github_rejected",
] as const;

export const listGitHubRepositoryCandidatesResponseSchema = z
  .object({
    candidates: z.array(githubRepositoryCandidateSchema),
    /** Why `candidates` is empty when it could not be read. */
    unavailable: z
      .enum(GITHUB_REPOSITORY_CANDIDATES_UNAVAILABLE_VALUES)
      .nullable(),
  })
  .strict();

export const postGitHubRepositoryRequestSchema = z
  .object({
    github_repository_id: z.number().int().positive(),
    id: catalogRepositoryIdSchema.optional(),
  })
  .strict();

export const patchGitHubRepositoryRequestSchema = z
  .object({
    branch: repositoryBranchSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const githubRepositoryWriteResponseSchema = z
  .object({
    repository: catalogGitHubRepositorySchema,
    receipt_id: receiptIdSchema,
  })
  .strict();

export const deleteGitHubRepositoryResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

/** `details` of a 409 `REPOSITORY_IN_USE`. */
export const repositoryInUseDetailsSchema = z
  .object({
    installation_profiles: z.array(z.string()),
    agents: z.array(z.string()),
  })
  .strict();

export type CatalogGitHubRepository = z.infer<
  typeof catalogGitHubRepositorySchema
>;
export type ListGitHubRepositoriesResponse = z.infer<
  typeof listGitHubRepositoriesResponseSchema
>;
export type GitHubRepositoryCandidate = z.infer<
  typeof githubRepositoryCandidateSchema
>;
export type ListGitHubRepositoryCandidatesResponse = z.infer<
  typeof listGitHubRepositoryCandidatesResponseSchema
>;
export type PostGitHubRepositoryRequest = z.infer<
  typeof postGitHubRepositoryRequestSchema
>;
export type PatchGitHubRepositoryRequest = z.infer<
  typeof patchGitHubRepositoryRequestSchema
>;
export type GitHubRepositoryWriteResponse = z.infer<
  typeof githubRepositoryWriteResponseSchema
>;
export type DeleteGitHubRepositoryResponse = z.infer<
  typeof deleteGitHubRepositoryResponseSchema
>;

import { z } from "zod";

import { receiptIdSchema, timestampSchema } from "../shared/index.ts";
import { githubAppPermissionsSchema } from "./github-app.ts";
import {
  GITHUB_UNAVAILABLE_VALUES,
  githubAppRoleSchema,
} from "./github-settings.ts";
import { workspaceParamsSchema } from "./workspaces.ts";

// GitHub App repositories are read from the author App's installations, a
// page at a time (decision settings-replace-file-catalog.md §1.1). The
// catalog keeps only the rows a pick resolved, beside the operator file's
// entries, which stay read-only.

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
  "selection",
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
    /**
     * Whether an author App installation reaches it now; null when GitHub
     * was not asked, could not answer, or the row was past the ones asked.
     */
    installed: z.boolean().nullable(),
    updated_at: timestampSchema.nullable(),
  })
  .strict();

export const GITHUB_REPOSITORIES_PER_PAGE_MAX = 100;

/** `?installation_id=&page=&per_page=`: one page of one installation. */
export const githubRepositoryPageQuerySchema = z
  .object({
    /** Absent: the first installation by account name. */
    installation_id: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).max(1000).default(1),
    per_page: z.coerce
      .number()
      .int()
      .min(1)
      .max(GITHUB_REPOSITORIES_PER_PAGE_MAX)
      .default(30),
  })
  .strict();

export const githubAppInstallationSummarySchema = z
  .object({
    id: z.number().int().positive(),
    /** The organization or user it is installed on. */
    account: z.string().min(1),
    /** The registered App's row id. */
    connection_id: z.string().min(1),
    role: githubAppRoleSchema,
    /** What the account approved for this installation. */
    permissions: githubAppPermissionsSchema,
    /** GitHub's count; null when it was not read. */
    repository_count: z.number().int().min(0).nullable(),
  })
  .strict();

export const installedGitHubRepositorySchema = z
  .object({
    github_repository_id: z.number().int().positive(),
    full_name: z.string().min(1),
    default_branch: z.string().min(1),
    private: z.boolean(),
    /** The catalog id a pick resolved it to; null until one does. */
    catalog_id: z.string().min(1).nullable(),
  })
  .strict();

/**
 * Why there is no page to show. For the default page GitHub failing is one
 * of GITHUB_UNAVAILABLE_VALUES and every installation suspended is
 * `installation_suspended`, so the catalog and the installations read still
 * come back; for a named installation they are 502 GITHUB_UNAVAILABLE with
 * that `reason_code` and 409 INSTALLATION_SUSPENDED.
 */
export const GITHUB_REPOSITORIES_UNAVAILABLE_VALUES = [
  // No author App is registered.
  "no_author_app",
  // No registered App is installed anywhere.
  "no_installation",
  "installation_suspended",
  ...GITHUB_UNAVAILABLE_VALUES,
] as const;

export const githubRepositoryPinsSchema = z
  .object({
    author: z.uuid().nullable(),
    reviewer: z.uuid().nullable(),
  })
  .strict();

export const githubRepositoryAppPinParamsSchema = workspaceParamsSchema
  .extend({
    repositoryId: z.string().min(1).max(200),
    role: githubAppRoleSchema,
  })
  .strict();

export const putGitHubRepositoryAppPinRequestSchema = z
  .object({ connection_id: z.uuid() })
  .strict();

export const putGitHubRepositoryAppPinResponseSchema = z
  .object({
    catalog_id: z.string().min(1),
    role: githubAppRoleSchema,
    connection_id: z.uuid(),
    /** Null when it was already pinned there: nothing changed. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/** What a repository's pins may be set to. */
export const getGitHubRepositoryAppPinsResponseSchema = z
  .object({
    catalog_id: z.string().min(1),
    pins: githubRepositoryPinsSchema,
    /** Every connection, and whether its App reaches the repository now. */
    candidates: z.array(
      z
        .object({
          connection_id: z.uuid(),
          role: githubAppRoleSchema,
          name: z.string().min(1),
          app_id: z.number().int().positive(),
          /** Null when GitHub did not answer. */
          installed: z.boolean().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const installationPageFields = {
  installations: z.array(githubAppInstallationSummarySchema),
  /** The installation this page is of; null with no installation. */
  installation_id: z.number().int().positive().nullable(),
  page: z.number().int().min(1),
  per_page: z.number().int().min(1),
  /** GitHub's count of the installation's repositories. */
  total_count: z.number().int().min(0),
};

export const listGitHubRepositoriesResponseSchema = z
  .object({
    ...installationPageFields,
    repositories: z.array(
      installedGitHubRepositorySchema
        .extend({
          /** Agents whose active release names its catalog id. */
          agent_count: z.number().int().min(0),
        })
        .strict(),
    ),
    unavailable: z.enum(GITHUB_REPOSITORIES_UNAVAILABLE_VALUES).nullable(),
    /**
     * The catalog's GitHub repositories: rows picks resolved (any branch is
     * changed here), and the operator file's entries, read-only.
     */
    catalog: z.array(
      catalogGitHubRepositorySchema
        .extend({
          /** Agents whose active release names it. */
          agent_count: z.number().int().min(0),
          /**
           * The connection pinned per role; null when none is, or when the
           * pinned one was removed (the gate then refuses the role's work).
           * Absent for a file entry, which uses its own App.
           */
          pins: githubRepositoryPinsSchema.optional(),
        })
        .strict(),
    ),
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

export const AGENT_GITHUB_REPOSITORIES_UNAVAILABLE_VALUES = [
  ...GITHUB_REPOSITORIES_UNAVAILABLE_VALUES,
  "no_active_release",
  // The active release's ceiling lists its repositories: pick among
  // `options.repositories` of GET /v1/agents/{id}/github instead.
  "ceiling_listed",
] as const;

export const listAgentGitHubRepositoriesResponseSchema = z
  .object({
    ...installationPageFields,
    repositories: z.array(installedGitHubRepositorySchema),
    unavailable: z
      .enum(AGENT_GITHUB_REPOSITORIES_UNAVAILABLE_VALUES)
      .nullable(),
  })
  .strict();

export const pickAgentGitHubRepositoryRequestSchema = z
  .object({
    installation_id: z.number().int().positive(),
    github_repository_id: z.number().int().positive(),
  })
  .strict();

export const pickAgentGitHubRepositoryResponseSchema = z
  .object({
    /** The id to name in the release's `github.repositories`. */
    catalog_id: z.string().min(1),
    /** Null unless this pick added the row or moved it to a new name. */
    receipt_id: receiptIdSchema.nullable(),
    /**
     * The author connection the repository is pinned to: the picked
     * installation's, or the one pinned before, which a pick leaves be.
     */
    connection_id: z.uuid().optional(),
  })
  .strict();

export type GitHubRepositoryPins = z.infer<typeof githubRepositoryPinsSchema>;
export type PutGitHubRepositoryAppPinRequest = z.infer<
  typeof putGitHubRepositoryAppPinRequestSchema
>;
export type PutGitHubRepositoryAppPinResponse = z.infer<
  typeof putGitHubRepositoryAppPinResponseSchema
>;
export type GetGitHubRepositoryAppPinsResponse = z.infer<
  typeof getGitHubRepositoryAppPinsResponseSchema
>;

export type CatalogGitHubRepository = z.infer<
  typeof catalogGitHubRepositorySchema
>;
export type GitHubRepositoryPageQuery = z.infer<
  typeof githubRepositoryPageQuerySchema
>;
export type ListGitHubRepositoriesResponse = z.infer<
  typeof listGitHubRepositoriesResponseSchema
>;
export type InstalledGitHubRepository = z.infer<
  typeof installedGitHubRepositorySchema
>;
export type PatchGitHubRepositoryRequest = z.infer<
  typeof patchGitHubRepositoryRequestSchema
>;
export type GitHubRepositoryWriteResponse = z.infer<
  typeof githubRepositoryWriteResponseSchema
>;
export type ListAgentGitHubRepositoriesResponse = z.infer<
  typeof listAgentGitHubRepositoriesResponseSchema
>;
export type PickAgentGitHubRepositoryRequest = z.infer<
  typeof pickAgentGitHubRepositoryRequestSchema
>;
export type PickAgentGitHubRepositoryResponse = z.infer<
  typeof pickAgentGitHubRepositoryResponseSchema
>;

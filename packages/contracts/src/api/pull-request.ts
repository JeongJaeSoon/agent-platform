import { z } from "zod";

import {
  receiptIdSchema,
  sessionIdSchema,
  timestampSchema,
} from "../shared/index.ts";
import { pushRequestIdSchema } from "./push-request.ts";

/** The pull request the platform opened from a pushed push request. */
export const pullRequestSchema = z.object({
  push_request_id: pushRequestIdSchema,
  session_id: sessionIdSchema,
  repository_id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.url(),
  head: z.string().min(1),
  base: z.string().min(1),
  created_at: timestampSchema,
  // The `open_pull_request` receipt of the call that recorded it.
  receipt_id: receiptIdSchema,
});

// Text a caller sends is cleaned before the forge sees it (mentions,
// cross-references and closing keywords broken, secret-shaped lines
// redacted) and cut to the forge's limit, so the caps here only bound the
// request.
export const openPullRequestRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(1000).optional(),
    body: z.string().max(60_000).optional(),
  })
  .strict();

export const PULL_REQUEST_COMMENT_MARKER_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_PULL_REQUEST_COMMENT_MARKER = "status";

export const commentPullRequestRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(60_000),
    // One comment per marker: posting the same marker again edits it.
    marker: z.string().regex(PULL_REQUEST_COMMENT_MARKER_PATTERN).optional(),
  })
  .strict();

export const openPullRequestResponseSchema = z.object({
  pull_request: pullRequestSchema,
  // False when the pull request was already open (or recorded) and this
  // call only answered it.
  created: z.boolean(),
  receipt_id: receiptIdSchema,
});

export const pullRequestCommentSchema = z.object({
  id: z.number().int().positive(),
  url: z.url(),
  marker: z.string(),
  created: z.boolean(),
});

export const commentPullRequestResponseSchema = z.object({
  pull_request: pullRequestSchema,
  comment: pullRequestCommentSchema,
  receipt_id: receiptIdSchema,
});

// Why opening or commenting on a pull request was refused, as its receipt
// and error details say.
export const PULL_REQUEST_REFUSAL_VALUES = [
  "missing_scope",
  "unverified_principal",
  "not_found",
  "not_pushed",
  "catalog_changed",
  "no_forge",
  "no_pull_request",
  "forge_failed",
] as const;
export const pullRequestRefusalSchema = z.enum(PULL_REQUEST_REFUSAL_VALUES);

/**
 * `result` of an `open_pull_request` or `comment_pull_request` receipt.
 * Fields the attempt never learned are null.
 */
export const pullRequestReceiptResultSchema = z.object({
  push_request_id: pushRequestIdSchema.nullable(),
  verdict: z.enum(["allow", "refuse"]),
  refusal: pullRequestRefusalSchema.nullable(),
  repository_id: z.string().nullable(),
  number: z.number().int().nullable(),
  url: z.string().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  created: z.boolean().nullable(),
  // A comment receipt only.
  comment_id: z.number().int().nullable().optional(),
  comment_url: z.string().nullable().optional(),
  marker: z.string().nullable().optional(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;
export type OpenPullRequestRequest = z.infer<
  typeof openPullRequestRequestSchema
>;
export type CommentPullRequestRequest = z.infer<
  typeof commentPullRequestRequestSchema
>;
export type OpenPullRequestResponse = z.infer<
  typeof openPullRequestResponseSchema
>;
export type CommentPullRequestResponse = z.infer<
  typeof commentPullRequestResponseSchema
>;
export type PullRequestRefusal = z.infer<typeof pullRequestRefusalSchema>;
export type PullRequestReceiptResult = z.infer<
  typeof pullRequestReceiptResultSchema
>;

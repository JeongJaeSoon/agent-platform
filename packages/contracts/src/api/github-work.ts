import { z } from "zod";

import { receiptIdSchema, sessionIdParamsSchema } from "../shared/index.ts";

/** A file under `.github/workflows/`, as an allow-list entry names it. */
export const githubWorkflowFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\.ya?ml$/);

/** A branch name; GitHub receives it as `refs/heads/<ref>`. */
export const githubBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!refs\/)(?!\/)(?!.*\/\/)(?!.*\.\.)[^\s~^:?*[\\]+(?<![/.])$/)
  .refine(
    (ref) =>
      [...ref].every((char) => {
        const code = char.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      }),
    { message: "control characters are not allowed" },
  );

export const GITHUB_DISPATCH_INPUTS_MAX = 25;

export const dispatchWorkflowRequestSchema = z
  .object({
    workflow: githubWorkflowFileSchema,
    ref: githubBranchSchema,
    // Passed to GitHub as they are; never kept in a receipt or a log.
    inputs: z
      .record(z.string().min(1).max(100), z.string().max(65_536))
      .refine(
        (inputs) => Object.keys(inputs).length <= GITHUB_DISPATCH_INPUTS_MAX,
        { message: `at most ${GITHUB_DISPATCH_INPUTS_MAX} inputs` },
      )
      .optional(),
  })
  .strict();

export const githubWorkflowRunRefSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.url(),
});

/** `run` is null when GitHub named no run for the dispatch. */
export const dispatchWorkflowResponseSchema = z.object({
  receipt_id: receiptIdSchema,
  run: githubWorkflowRunRefSchema.nullable(),
});

export const workflowRunParamsSchema = sessionIdParamsSchema.extend({
  run_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const githubWorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  path: z.string(),
  head_branch: z.string().nullable(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.url(),
});

export const rerunWorkflowRequestSchema = z
  .object({ failed_only: z.boolean().optional() })
  .strict();

export const rerunWorkflowResponseSchema = z.object({
  receipt_id: receiptIdSchema,
});

export type DispatchWorkflowRequest = z.infer<
  typeof dispatchWorkflowRequestSchema
>;
export type DispatchWorkflowResponse = z.infer<
  typeof dispatchWorkflowResponseSchema
>;
export type GitHubWorkflowRunView = z.infer<typeof githubWorkflowRunSchema>;
export type RerunWorkflowRequest = z.infer<typeof rerunWorkflowRequestSchema>;
export type RerunWorkflowResponse = z.infer<typeof rerunWorkflowResponseSchema>;

import { z } from "zod";

import {
  attemptIdSchema,
  requestIdSchema,
  requiredUnknownSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";

export const pendingQuestionOptionSchema = z.object({
  option_id: z.string().min(1),
  label: z.string().min(1),
});
export const pendingQuestionSchema = z.object({
  question_id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(pendingQuestionOptionSchema),
  multi_select: z.boolean(),
  allow_free_text: z.boolean(),
});

const pendingRequestBase = {
  request_id: requestIdSchema,
  turn_id: turnIdSchema,
  attempt_id: attemptIdSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
};
export const pendingRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    ...pendingRequestBase,
    kind: z.literal("permission"),
    tool: z.string().min(1),
    input: requiredUnknownSchema,
  }),
  z.object({
    ...pendingRequestBase,
    kind: z.literal("question"),
    questions: z.array(pendingQuestionSchema).min(1),
  }),
]);
export const listPendingRequestsResponseSchema = z.object({
  items: z.array(pendingRequestSchema),
});

export type PendingQuestionOption = z.infer<typeof pendingQuestionOptionSchema>;
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;
export type PendingRequest = z.infer<typeof pendingRequestSchema>;
export type ListPendingRequestsResponse = z.infer<
  typeof listPendingRequestsResponseSchema
>;

import { z } from "zod";

import { requestIdSchema } from "../shared/index.ts";
import { receiptAcceptedResponseSchema } from "./receipt.ts";

export const permissionAnswerSchema = z
  .object({
    request_id: requestIdSchema,
    kind: z.literal("permission"),
    decision: z.enum(["allow", "deny"]),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const questionAnswerSchema = z
  .object({
    question_id: z.string().min(1),
    selected_option_ids: z.array(z.string().min(1)),
    free_text: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (answer) =>
      answer.selected_option_ids.length > 0 || answer.free_text !== undefined,
    "An answer needs a selected option or free text",
  );

export const questionsAnswerSchema = z
  .object({
    request_id: requestIdSchema,
    kind: z.literal("question"),
    answers: z.array(questionAnswerSchema).min(1),
  })
  .strict()
  .superRefine((answer, context) => {
    const ids = new Set<string>();
    for (const [index, item] of answer.answers.entries()) {
      if (ids.has(item.question_id)) {
        context.addIssue({
          code: "custom",
          message: "Question IDs must be unique",
          path: ["answers", index, "question_id"],
        });
      }
      ids.add(item.question_id);
    }
  });

export const postSessionAnswerRequestSchema = z.discriminatedUnion("kind", [
  permissionAnswerSchema,
  questionsAnswerSchema,
]);
export const postSessionAnswerResponseSchema = receiptAcceptedResponseSchema;

export type PermissionAnswer = z.infer<typeof permissionAnswerSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type QuestionsAnswer = z.infer<typeof questionsAnswerSchema>;
export type PostSessionAnswerRequest = z.infer<
  typeof postSessionAnswerRequestSchema
>;
export type PostSessionAnswerResponse = z.infer<
  typeof postSessionAnswerResponseSchema
>;

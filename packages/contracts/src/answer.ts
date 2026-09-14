import { z } from "zod";

export const permissionAnswerSchema = z
  .object({
    kind: z.literal("permission"),
    behavior: z.enum(["allow", "deny"]),
    message: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((answer, context) => {
    if (answer.behavior === "deny" && answer.message === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A denial message is required",
        path: ["message"],
      });
    }
  });

export const questionAnswerValueSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

export const questionAnswerSchema = z
  .object({
    question_id: z.string().min(1),
    value: questionAnswerValueSchema,
  })
  .strict();

export const questionsAnswerSchema = z
  .object({
    kind: z.literal("questions"),
    answers: z.array(questionAnswerSchema).min(1),
  })
  .strict()
  .superRefine((answer, context) => {
    const ids = new Set<string>();
    for (const [index, item] of answer.answers.entries()) {
      if (ids.has(item.question_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Question IDs must be unique",
          path: ["answers", index, "question_id"],
        });
      }
      ids.add(item.question_id);
    }
  });

export const sessionAnswerSchema = z.union([
  permissionAnswerSchema,
  questionsAnswerSchema,
]);

export const postSessionAnswerRequestSchema = z
  .object({
    request_id: z.string().min(1),
    answer: sessionAnswerSchema,
  })
  .strict();

export type PostSessionAnswerRequest = z.infer<
  typeof postSessionAnswerRequestSchema
>;
export type PermissionAnswer = z.infer<typeof permissionAnswerSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type QuestionsAnswer = z.infer<typeof questionsAnswerSchema>;
export type SessionAnswer = z.infer<typeof sessionAnswerSchema>;

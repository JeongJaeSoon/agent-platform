import { z } from "zod";

const requiredUnknownSchema = z
  .unknown()
  .refine((value) => value !== undefined, "Required");

export const postSessionAnswerRequestSchema = z.object({
  request_id: z.string().min(1),
  answer: requiredUnknownSchema,
});

export type PostSessionAnswerRequest = z.infer<
  typeof postSessionAnswerRequestSchema
>;
